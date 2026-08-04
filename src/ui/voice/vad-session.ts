/**
 * Hands-free MicVAD session (Silero v5) with confirmed grace period.
 *
 * Lazily imports the same-origin VAD loader only after a user gesture. Uses
 * model:"v5", startOnLoad:false, explicit asset roots, and shared mic lifecycle.
 * Pause before transcription/chat/TTS; destroy on End Call / unmount.
 */

import { concatFloat32, float32ToWav, pcmExceedsAudioCeiling } from "./audio-utils";
import { voiceError } from "./speech-errors";
import { stopMediaStream } from "./micPreferences";
import type { VoiceError } from "./types";

export type VadSessionCallbacks = {
  onSpeechStart?: () => void;
  /** Fired after grace period with a canonical 16 kHz mono WAV. */
  onSpeechEnd?: (wav: Blob) => void;
  onGraceChange?: (state: { active: boolean; progress: number }) => void;
  onError?: (error: VoiceError) => void;
};

export type VadSessionOptions = {
  gracePeriodMs: number;
  deviceId?: string;
  callbacks?: VadSessionCallbacks;
  /**
   * Injected loader for tests. Production uses dynamic
   * `import("./local").loadVadEngine` only after Start Call.
   */
  loadEngine?: () => Promise<VadEngineHandleLike>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
};

/** onnxruntime-web wasmPaths object form (hashed same-origin URLs). */
export type VadOrtWasmPaths = {
  mjs: string;
  wasm: string;
};

export type VadEngineHandleLike = {
  workletUrl: string;
  modelUrl: string;
  /** @deprecated Prefer ortWasmPaths — directory prefixes break under hashed builds. */
  ortWasmBaseUrl: string;
  /** Exact content-hashed ORT mjs+wasm URLs required under Vite builds. */
  ortWasmPaths: VadOrtWasmPaths;
  MicVAD: {
    new: (options: Record<string, unknown>) => Promise<MicVadLike>;
  };
  dispose?: () => void;
};

export type MicVadLike = {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
  listening?: boolean;
};

export type VadSession = {
  readonly active: boolean;
  readonly isInGracePeriod: boolean;
  readonly gracePeriodProgress: number;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  destroy: () => Promise<void>;
};

type LoadVadEngineFn = () => Promise<VadEngineHandleLike>;

async function defaultLoadEngine(): Promise<VadEngineHandleLike> {
  // Bridge keeps Whisper/Kokoro/Piper asset graphs out of the AI chat chunk.
  const mod = await import("./vad-loader.ts");
  return mod.loadVadEngineBridge() as Promise<VadEngineHandleLike>;
}

type OrtConfigTarget = {
  env?: {
    wasm?: {
      wasmPaths?: string | { mjs?: string; wasm?: string };
    };
  };
};

/**
 * Briefly redirect MicVAD's fixed asset filenames to Vite's content-hashed
 * same-origin URLs during construction only.
 *
 * MicVAD assigns `onnxWASMBasePath` (a directory prefix) to
 * `ort.env.wasm.wasmPaths` first, then invokes `ortConfig`. We overwrite with
 * the exact hashed `{ mjs, wasm }` object after that assignment so ORT does not
 * fall back to unhashed same-origin filenames.
 */
async function constructMicVad(
  handle: VadEngineHandleLike,
  options: Record<string, unknown>,
): Promise<MicVadLike> {
  const origFetch = globalThis.fetch.bind(globalThis);
  const workletProto = typeof AudioWorklet !== "undefined" ? AudioWorklet.prototype : null;
  const origAddModule = workletProto?.addModule;
  const ortWasmPaths = {
    mjs: handle.ortWasmPaths.mjs,
    wasm: handle.ortWasmPaths.wasm,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("silero_vad_v5")) {
      return origFetch(handle.modelUrl, init);
    }
    return origFetch(input, init);
  }) as typeof fetch;

  if (workletProto && origAddModule) {
    workletProto.addModule = async function patchedAddModule(
      this: AudioWorklet,
      moduleURL: string | URL,
      opts?: WorkletOptions,
    ) {
      const url = String(moduleURL);
      if (url.includes("vad.worklet")) {
        return origAddModule.call(this, handle.workletUrl, opts);
      }
      return origAddModule.call(this, moduleURL, opts);
    };
  }

  try {
    return await handle.MicVAD.new({
      ...options,
      model: "v5",
      startOnLoad: false,
      baseAssetPath: "/",
      onnxWASMBasePath: handle.ortWasmBaseUrl.endsWith("/")
        ? handle.ortWasmBaseUrl
        : `${handle.ortWasmBaseUrl}/`,
      // Runs after MicVAD sets wasmPaths from onnxWASMBasePath (see package source).
      ortConfig: (ort: OrtConfigTarget) => {
        if (!ort.env) ort.env = {};
        if (!ort.env.wasm) ort.env.wasm = {};
        ort.env.wasm.wasmPaths = {
          mjs: ortWasmPaths.mjs,
          wasm: ortWasmPaths.wasm,
        };
      },
    });
  } finally {
    globalThis.fetch = origFetch;
    if (workletProto && origAddModule) {
      workletProto.addModule = origAddModule;
    }
  }
}

export function createVadSession(options: VadSessionOptions): VadSession {
  const gracePeriodMs = Math.max(0, Math.floor(options.gracePeriodMs));
  const loadEngine: LoadVadEngineFn = options.loadEngine ?? defaultLoadEngine;
  const getUserMedia =
    options.getUserMedia ??
    ((constraints: MediaStreamConstraints) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        return Promise.reject(voiceError("unsupported"));
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    });

  let vad: MicVadLike | null = null;
  let engine: VadEngineHandleLike | null = null;
  let ownedStream: MediaStream | null = null;
  let active = false;
  let destroyed = false;
  let paused = false;
  let isInGracePeriod = false;
  let gracePeriodProgress = 0;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let graceAnim: number | null = null;
  let graceStartedAt = 0;
  const audioBuffer: Float32Array[] = [];
  const callbacks = options.callbacks ?? {};

  const clearGrace = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (graceAnim !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(graceAnim);
      graceAnim = null;
    }
    isInGracePeriod = false;
    gracePeriodProgress = 0;
    callbacks.onGraceChange?.({ active: false, progress: 0 });
  };

  const flushBuffer = () => {
    clearGrace();
    if (audioBuffer.length === 0) return;
    const chunks = audioBuffer.splice(0, audioBuffer.length);
    const combined = concatFloat32(chunks);
    if (combined.length === 0) return;
    if (pcmExceedsAudioCeiling(combined.length)) {
      callbacks.onError?.(voiceError("audio_too_large"));
      return;
    }
    const wav = float32ToWav(combined, 16_000);
    callbacks.onSpeechEnd?.(wav);
  };

  const beginGrace = (audio: Float32Array) => {
    audioBuffer.push(audio);
    if (gracePeriodMs <= 0) {
      flushBuffer();
      return;
    }
    isInGracePeriod = true;
    graceStartedAt = Date.now();
    gracePeriodProgress = 0;
    callbacks.onGraceChange?.({ active: true, progress: 0 });

    const animate = () => {
      const elapsed = Date.now() - graceStartedAt;
      const progress = Math.min(elapsed / gracePeriodMs, 1);
      gracePeriodProgress = progress;
      callbacks.onGraceChange?.({ active: true, progress });
      if (progress < 1 && typeof requestAnimationFrame === "function") {
        graceAnim = requestAnimationFrame(animate);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      graceAnim = requestAnimationFrame(animate);
    }

    graceTimer = setTimeout(() => {
      flushBuffer();
    }, gracePeriodMs);
  };

  return {
    get active() {
      return active;
    },
    get isInGracePeriod() {
      return isInGracePeriod;
    },
    get gracePeriodProgress() {
      return gracePeriodProgress;
    },
    async start() {
      if (destroyed || active) return;
      try {
        engine = await loadEngine();
        if (destroyed) {
          engine.dispose?.();
          return;
        }

        const audioConstraints: MediaTrackConstraints = options.deviceId
          ? {
              deviceId: { exact: options.deviceId },
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
            }
          : {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
            };

        vad = await constructMicVad(engine, {
          redemptionMs: Math.min(Math.max(gracePeriodMs, 100), 3000),
          getStream: async () => {
            ownedStream = await getUserMedia({ audio: audioConstraints, video: false });
            return ownedStream;
          },
          pauseStream: async (stream: MediaStream) => {
            // Half-duplex pause: stop tracks so the mic indicator clears.
            stopMediaStream(stream);
            if (ownedStream === stream) ownedStream = null;
          },
          resumeStream: async () => {
            ownedStream = await getUserMedia({ audio: audioConstraints, video: false });
            return ownedStream;
          },
          onSpeechStart: () => {
            if (destroyed || paused) return;
            if (graceTimer) {
              // User resumed during grace — keep buffering.
              if (graceTimer) {
                clearTimeout(graceTimer);
                graceTimer = null;
              }
              if (graceAnim !== null && typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(graceAnim);
                graceAnim = null;
              }
              isInGracePeriod = false;
              gracePeriodProgress = 0;
              callbacks.onGraceChange?.({ active: false, progress: 0 });
            }
            callbacks.onSpeechStart?.();
          },
          onSpeechEnd: (audio: Float32Array) => {
            if (destroyed || paused) return;
            beginGrace(audio);
          },
        });

        if (destroyed) {
          await vad.destroy().catch(() => undefined);
          vad = null;
          return;
        }

        await vad.start();
        active = true;
        paused = false;
      } catch {
        active = false;
        callbacks.onError?.(voiceError("vad_failed"));
        await this.destroy();
      }
    },
    async pause() {
      if (!vad || !active || paused) return;
      paused = true;
      // Flush any pending grace audio before pausing listening.
      if (audioBuffer.length > 0) flushBuffer();
      else clearGrace();
      try {
        await vad.pause();
      } catch {
        // ignore
      }
    },
    async resume() {
      if (!vad || !active || destroyed) return;
      if (!paused) return;
      paused = false;
      try {
        await vad.start();
      } catch {
        callbacks.onError?.(voiceError("vad_failed"));
      }
    },
    async destroy() {
      destroyed = true;
      active = false;
      paused = false;
      clearGrace();
      audioBuffer.length = 0;
      const current = vad;
      vad = null;
      if (current) {
        try {
          await current.pause();
        } catch {
          // ignore
        }
        try {
          await current.destroy();
        } catch {
          // ignore
        }
      }
      stopMediaStream(ownedStream);
      ownedStream = null;
      engine?.dispose?.();
      engine = null;
    },
  };
}
