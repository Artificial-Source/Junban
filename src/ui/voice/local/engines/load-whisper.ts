/**
 * Dynamic-only Whisper engine owner.
 *
 * Verifies model bytes into OPFS (store-only on the worker load path), configures
 * Transformers.js with a fail-closed verified custom cache and same-origin ORT,
 * then constructs one q4 automatic-speech-recognition pipeline. Inference runs
 * only through the returned handle — never at module evaluation.
 */

import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { getLocalVoicePackage } from "../manifest.ts";
import {
  boundTranscript,
  LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ,
  LocalVoiceClientError,
  validateWhisperPcm,
} from "../protocol.ts";
import { loadWhisperRuntimeAssets } from "../same-origin-assets.ts";
import { reverifyCachedPackage } from "../verify-fetch.ts";
import { configureVerifiedTransformers } from "./configure-transformers.ts";

export const WHISPER_PACKAGE_ID = "whisper-tiny.en-q4";
export const WHISPER_DTYPE = "q4" as const;
export const WHISPER_DEVICE = "wasm" as const;
export const WHISPER_TASK = "automatic-speech-recognition" as const;

export type WhisperLoadOptions = {
  signal?: AbortSignal;
  onProgress?: (loadedFiles: number, totalFiles: number) => void;
};

export type WhisperEngineHandle = {
  readonly packageId: string;
  readonly modelId: string;
  readonly revision: string;
  /** Transcribe 16 kHz mono Float32 PCM; returns a bounded nonempty transcript. */
  transcribe: (samples: Float32Array) => Promise<string>;
  /** Dispose retained pipeline state. Does not delete verified model store. */
  dispose: () => Promise<void>;
};

/**
 * Require a fully re-verified OPFS package, configure transformers, and create
 * one Whisper q4 pipeline. Fails closed on cache miss — no network fallback.
 */
export async function loadWhisperEngine(
  options: WhisperLoadOptions = {},
): Promise<WhisperEngineHandle> {
  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }

  const pkg = getLocalVoicePackage(WHISPER_PACKAGE_ID);
  const assets = await loadWhisperRuntimeAssets();

  const verified = await reverifyCachedPackage(WHISPER_PACKAGE_ID);
  if (!verified) {
    throw new LocalVoiceClientError("cache_miss");
  }
  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }
  options.onProgress?.(pkg.files.length, pkg.files.length);

  const transformers = await import("@huggingface/transformers");
  configureVerifiedTransformers(transformers.env, WHISPER_PACKAGE_ID, assets.ortWasmPaths);

  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }

  let pipeline: AutomaticSpeechRecognitionPipeline;
  try {
    pipeline = await transformers.pipeline(WHISPER_TASK, pkg.repo, {
      dtype: WHISPER_DTYPE,
      revision: pkg.revision,
      device: WHISPER_DEVICE,
    });
  } catch {
    throw new LocalVoiceClientError("load_failed");
  }

  let disposed = false;

  return {
    packageId: pkg.id,
    modelId: pkg.repo,
    revision: pkg.revision,
    async transcribe(samples: Float32Array): Promise<string> {
      if (disposed) {
        throw new LocalVoiceClientError("disposed");
      }
      // Re-wrap as ArrayBuffer-backed view for validation of byte bounds.
      const copy = new Float32Array(samples.length);
      copy.set(samples);
      const validated = validateWhisperPcm(copy.buffer, LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ);
      if (!validated.ok) {
        throw new LocalVoiceClientError(validated.code);
      }
      let raw: { text?: string } | Array<{ text?: string }>;
      try {
        raw = await pipeline(validated.samples);
      } catch {
        throw new LocalVoiceClientError("infer_failed");
      }
      const text = Array.isArray(raw)
        ? (raw[0]?.text ?? "")
        : typeof raw?.text === "string"
          ? raw.text
          : "";
      const bounded = boundTranscript(text);
      if (!bounded.ok) {
        throw new LocalVoiceClientError(bounded.code);
      }
      return bounded.text;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        if (typeof pipeline.dispose === "function") {
          await pipeline.dispose();
        }
      } catch {
        // Disposal is best-effort; worker termination is final cancellation.
      }
    },
  };
}

/** Worker entry helper used by the dedicated whisper worker. */
export async function importWhisperPackage(): Promise<typeof import("@huggingface/transformers")> {
  return import("@huggingface/transformers");
}
