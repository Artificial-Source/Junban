/**
 * Local TTS playback helpers (PCM AudioContext + WAV object URL).
 *
 * No workers or engine packages. Callers own cancel/dispose cleanup.
 */

import { voiceError } from "./speech-errors";
import type { VoiceError } from "./types";
import { sanitizePcm } from "./local-adapter-audio";

export type LocalPlaybackHandle = {
  readonly done: Promise<void>;
  stop: () => void;
};

/** Play mono/interleaved Float32 PCM through an owned AudioBufferSourceNode. */
export function playPcmWithAudioContext(
  samples: Float32Array,
  sampleRate: number,
  options: {
    signal?: AbortSignal;
    channels?: number;
    audioContext?: AudioContext;
  } = {},
): LocalPlaybackHandle {
  let stopped = false;
  let settled = false;
  let context: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let settleOk: (() => void) | null = null;
  let settleErr: ((error: VoiceError) => void) | null = null;
  const ownsContext = !options.audioContext;

  const cleanup = () => {
    try {
      source?.stop();
    } catch {
      // ignore
    }
    try {
      source?.disconnect();
    } catch {
      // ignore
    }
    source = null;
    if (ownsContext && context) {
      void context.close().catch(() => undefined);
    }
    context = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
    if (!settled) {
      settled = true;
      settleOk?.();
    }
  };

  if (options.signal?.aborted) {
    return { done: Promise.resolve(), stop };
  }

  const channels = Math.max(1, Math.floor(options.channels ?? 1));
  const clean = sanitizePcm(samples);
  if ("code" in clean) {
    return {
      done: Promise.reject(clean),
      stop,
    };
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return {
      done: Promise.reject(voiceError("playback_failed")),
      stop,
    };
  }

  const onAbort = () => stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const done = new Promise<void>((resolve, reject) => {
    settleOk = () => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    settleErr = (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    try {
      const Ctx =
        options.audioContext?.constructor ??
        (typeof AudioContext !== "undefined" ? AudioContext : null);
      if (!Ctx && !options.audioContext) {
        settled = true;
        settleErr(voiceError("unsupported"));
        return;
      }
      context = options.audioContext ?? new (Ctx as typeof AudioContext)();
      const frameCount = Math.floor(clean.length / channels);
      if (frameCount <= 0) {
        settled = true;
        cleanup();
        settleErr(voiceError("empty_audio"));
        return;
      }
      const buffer = context.createBuffer(channels, frameCount, sampleRate);
      if (channels === 1) {
        const mono = new Float32Array(frameCount);
        mono.set(clean.subarray(0, frameCount));
        buffer.copyToChannel(mono, 0);
      } else {
        for (let c = 0; c < channels; c += 1) {
          const channel = new Float32Array(frameCount);
          for (let i = 0; i < frameCount; i += 1) {
            channel[i] = clean[i * channels + c] ?? 0;
          }
          buffer.copyToChannel(channel, c);
        }
      }
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (settled) return;
        settled = true;
        cleanup();
        settleOk?.();
      };
      source.start(0);
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
    } catch {
      if (settled) return;
      settled = true;
      cleanup();
      settleErr?.(voiceError("playback_failed"));
    }
  });

  return { done, stop };
}

/** Play a WAV/blob via HTMLAudioElement + object URL. */
export function playWavBlob(
  blob: Blob,
  options: {
    signal?: AbortSignal;
    audioElement?: HTMLAudioElement;
    createObjectUrl?: (blob: Blob) => string;
    revokeObjectUrl?: (url: string) => void;
  } = {},
): LocalPlaybackHandle {
  const createUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
  const revokeUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
  const audio = options.audioElement ?? new Audio();
  let url: string | null = null;
  let stopped = false;

  const cleanup = () => {
    try {
      audio.pause();
    } catch {
      // ignore
    }
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // ignore
    }
    if (url) {
      try {
        revokeUrl(url);
      } catch {
        // ignore
      }
      url = null;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
  };

  if (options.signal?.aborted) {
    return { done: Promise.resolve(), stop };
  }

  const onAbort = () => stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const done = new Promise<void>((resolve, reject) => {
    try {
      url = createUrl(blob);
      audio.preload = "auto";
      audio.src = url;
      const settleOk = () => {
        options.signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve();
      };
      const settleErr = () => {
        options.signal?.removeEventListener("abort", onAbort);
        cleanup();
        if (stopped) resolve();
        else reject(voiceError("playback_failed"));
      };
      audio.onended = () => settleOk();
      audio.onerror = () => settleErr();
      const playResult = audio.play();
      if (playResult && typeof playResult.then === "function") {
        playResult.then(() => {
          if (stopped) settleOk();
        }, settleErr);
      }
    } catch {
      options.signal?.removeEventListener("abort", onAbort);
      cleanup();
      reject(voiceError("playback_failed"));
    }
  });

  return { done, stop };
}
