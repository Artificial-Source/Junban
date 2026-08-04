/**
 * Local Whisper/Kokoro/Piper adapter owners.
 *
 * Dynamically imported by the AI-route hook only when confirmed browser
 * provider + explicit local preference select a package. Not a global singleton.
 */

import { blobToWhisperPcm } from "./local-adapter-audio";
import { playPcmWithAudioContext, playWavBlob } from "./local-adapter-playback";
import { isAbortLike, voiceError } from "./speech-errors";
import type { LocalAdapterStatus, LocalSttAdapter, LocalTtsAdapter } from "./types";
import type { LocalSttPackageId, LocalTtsPackageId } from "./localPreferences";
import {
  createLocalKokoroClient,
  createLocalPiperClient,
  createLocalWhisperClient,
  getLocalEngineStatus,
  type LocalKokoroClient,
  type LocalPiperClient,
  type LocalWhisperClient,
} from "./local/index";

export type LocalSttAdapterOwner = LocalSttAdapter & {
  readonly packageId: LocalSttPackageId;
  /** Load verified cache + worker. Safe to await once after construction. */
  prepare(): Promise<void>;
};

export type LocalTtsAdapterOwner = LocalTtsAdapter & {
  readonly packageId: LocalTtsPackageId;
  prepare(): Promise<void>;
};

export type CreateLocalSttAdapterOptions = {
  packageId: LocalSttPackageId;
  createClient?: () => LocalWhisperClient;
  onStatus?: (status: LocalAdapterStatus) => void;
};

export type CreateLocalTtsAdapterOptions = {
  packageId: LocalTtsPackageId;
  createKokoroClient?: () => LocalKokoroClient;
  createPiperClient?: () => LocalPiperClient;
  onStatus?: (status: LocalAdapterStatus) => void;
};

function setStatus(
  owner: { status: LocalAdapterStatus },
  next: LocalAdapterStatus,
  onStatus?: (status: LocalAdapterStatus) => void,
): void {
  owner.status = next;
  onStatus?.(next);
}

export function createLocalWhisperAdapter(
  options: CreateLocalSttAdapterOptions,
): LocalSttAdapterOwner {
  let client: LocalWhisperClient | null = null;
  let generation = 0;
  let disposed = false;
  let preparePromise: Promise<void> | null = null;
  let decodeContext: AudioContext | null = null;

  const owner: LocalSttAdapterOwner = {
    packageId: options.packageId,
    status: "loading",
    async prepare() {
      if (disposed) {
        setStatus(owner, "unavailable", options.onStatus);
        return;
      }
      if (preparePromise) return preparePromise;
      preparePromise = (async () => {
        try {
          setStatus(owner, "loading", options.onStatus);
          const status = await getLocalEngineStatus("whisper");
          if (disposed) return;
          if (!status.verified || status.packageId !== options.packageId) {
            setStatus(owner, "unavailable", options.onStatus);
            return;
          }
          const next = options.createClient?.() ?? createLocalWhisperClient();
          if (disposed) {
            await next.dispose();
            return;
          }
          client = next;
          const info = await next.load();
          if (disposed || info.packageId !== options.packageId) {
            await next.dispose();
            if (client === next) client = null;
            if (!disposed) setStatus(owner, "unavailable", options.onStatus);
            return;
          }
          generation = info.generation;
          setStatus(owner, "ready", options.onStatus);
        } catch {
          if (!disposed) setStatus(owner, "error", options.onStatus);
          if (client) {
            const dying = client;
            client = null;
            await dying.dispose().catch(() => undefined);
          }
        }
      })();
      return preparePromise;
    },
    async transcribe(audio, opts) {
      if (disposed) throw voiceError("aborted");
      if (owner.status !== "ready" || !client) {
        throw voiceError("unsupported", "Local speech model is not ready.");
      }
      const signal = opts?.signal;
      if (signal?.aborted) throw voiceError("aborted");

      let samples: Float32Array;
      try {
        samples = await blobToWhisperPcm(audio, {
          signal,
          audioContext: decodeContext ?? undefined,
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && "message" in error) {
          throw error;
        }
        if (isAbortLike(error) || signal?.aborted) throw voiceError("aborted");
        throw voiceError("audio_capture");
      }

      if (disposed || signal?.aborted) throw voiceError("aborted");
      try {
        const result = await client.transcribe(samples, generation, signal);
        // Drop large PCM promptly.
        samples.fill(0);
        if (disposed || signal?.aborted) throw voiceError("aborted");
        return result.text;
      } catch (error) {
        samples.fill(0);
        if (isAbortLike(error) || signal?.aborted) throw voiceError("aborted");
        if (error && typeof error === "object" && "code" in error) {
          const code = String((error as { code?: unknown }).code);
          if (code === "aborted" || code === "disposed") throw voiceError("aborted");
          if (code === "invalid_audio") throw voiceError("audio_capture");
        }
        throw voiceError("unknown", "Local transcription failed.");
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setStatus(owner, "unavailable", options.onStatus);
      const dying = client;
      client = null;
      generation = 0;
      if (decodeContext) {
        void decodeContext.close().catch(() => undefined);
        decodeContext = null;
      }
      if (dying) {
        void dying.dispose().catch(() => undefined);
      }
    },
  };

  return owner;
}

export function createLocalTtsAdapter(options: CreateLocalTtsAdapterOptions): LocalTtsAdapterOwner {
  let kokoro: LocalKokoroClient | null = null;
  let piper: LocalPiperClient | null = null;
  let generation = 0;
  let disposed = false;
  let preparePromise: Promise<void> | null = null;
  let playbackStop: (() => void) | null = null;
  let activePcm: Float32Array | null = null;

  const engine = options.packageId.startsWith("kokoro") ? "kokoro" : "piper";

  const clearAudio = () => {
    if (activePcm) {
      activePcm.fill(0);
      activePcm = null;
    }
  };

  const stopPlayback = () => {
    const stop = playbackStop;
    playbackStop = null;
    try {
      stop?.();
    } catch {
      // ignore
    }
    clearAudio();
  };

  const owner: LocalTtsAdapterOwner = {
    packageId: options.packageId,
    status: "loading",
    async prepare() {
      if (disposed) {
        setStatus(owner, "unavailable", options.onStatus);
        return;
      }
      if (preparePromise) return preparePromise;
      preparePromise = (async () => {
        try {
          setStatus(owner, "loading", options.onStatus);
          const status = await getLocalEngineStatus(engine);
          if (disposed) return;
          if (!status.verified || status.packageId !== options.packageId) {
            setStatus(owner, "unavailable", options.onStatus);
            return;
          }
          if (engine === "kokoro") {
            const next = options.createKokoroClient?.() ?? createLocalKokoroClient();
            if (disposed) {
              await next.dispose();
              return;
            }
            kokoro = next;
            const info = await next.load();
            if (disposed || info.packageId !== options.packageId) {
              await next.dispose();
              if (kokoro === next) kokoro = null;
              if (!disposed) setStatus(owner, "unavailable", options.onStatus);
              return;
            }
            generation = info.generation;
          } else {
            const next = options.createPiperClient?.() ?? createLocalPiperClient();
            if (disposed) {
              await next.dispose();
              return;
            }
            piper = next;
            const info = await next.load();
            if (disposed || info.packageId !== options.packageId) {
              await next.dispose();
              if (piper === next) piper = null;
              if (!disposed) setStatus(owner, "unavailable", options.onStatus);
              return;
            }
            generation = info.generation;
          }
          setStatus(owner, "ready", options.onStatus);
        } catch {
          if (!disposed) setStatus(owner, "error", options.onStatus);
          const dyingK = kokoro;
          const dyingP = piper;
          kokoro = null;
          piper = null;
          if (dyingK) await dyingK.dispose().catch(() => undefined);
          if (dyingP) await dyingP.dispose().catch(() => undefined);
        }
      })();
      return preparePromise;
    },
    async speak(text, opts) {
      if (disposed) throw voiceError("aborted");
      if (owner.status !== "ready") {
        throw voiceError("unsupported", "Local speech model is not ready.");
      }
      const signal = opts?.signal;
      if (signal?.aborted) throw voiceError("aborted");
      stopPlayback();

      try {
        if (engine === "kokoro") {
          if (!kokoro) throw voiceError("unsupported", "Local speech model is not ready.");
          const result = await kokoro.synthesize(text, generation, signal);
          if (disposed || signal?.aborted) throw voiceError("aborted");
          if (result.format !== "pcm-f32" || !result.pcm) {
            throw voiceError("playback_failed");
          }
          activePcm = result.pcm;
          const playback = playPcmWithAudioContext(result.pcm, result.sampleRate, {
            signal,
            channels: result.channels,
          });
          playbackStop = () => playback.stop();
          await playback.done;
        } else {
          if (!piper) throw voiceError("unsupported", "Local speech model is not ready.");
          const result = await piper.synthesize(text, generation, signal);
          if (disposed || signal?.aborted) throw voiceError("aborted");
          if (result.format !== "wav" || !result.wav) {
            throw voiceError("playback_failed");
          }
          const blob = new Blob([result.wav], { type: "audio/wav" });
          const playback = playWavBlob(blob, { signal });
          playbackStop = () => playback.stop();
          await playback.done;
        }
      } catch (error) {
        const wasCancelled = disposed || signal?.aborted;
        stopPlayback();
        // cancel()/dispose during playback is a successful quiet stop.
        if (wasCancelled || isAbortLike(error)) return;
        if (error && typeof error === "object" && "code" in error && "message" in error) {
          const code = String((error as { code?: unknown }).code);
          if (code === "aborted") return;
          throw error;
        }
        throw voiceError("playback_failed");
      } finally {
        playbackStop = null;
        clearAudio();
      }
    },
    cancel() {
      stopPlayback();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setStatus(owner, "unavailable", options.onStatus);
      stopPlayback();
      const dyingK = kokoro;
      const dyingP = piper;
      kokoro = null;
      piper = null;
      generation = 0;
      if (dyingK) void dyingK.dispose().catch(() => undefined);
      if (dyingP) void dyingP.dispose().catch(() => undefined);
    },
  };

  return owner;
}
