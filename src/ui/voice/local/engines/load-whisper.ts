/**
 * Dynamic-only Whisper loader/cache boundary.
 *
 * Verifies model bytes into OPFS, then configures Transformers.js to use a
 * fail-closed verified custom cache and same-origin ORT assets. This does not
 * construct a pipeline or run inference — that remains Wave 5.
 */

import { getLocalVoicePackage } from "../manifest.ts";
import { loadWhisperRuntimeAssets } from "../same-origin-assets.ts";
import { createVerifiedTransformersCache } from "../verified-model-cache.ts";
import { ensureVerifiedPackage } from "../verify-fetch.ts";

export const WHISPER_PACKAGE_ID = "whisper-tiny.en-q4";

export type WhisperLoadOptions = {
  signal?: AbortSignal;
  onProgress?: (loadedFiles: number, totalFiles: number) => void;
};

export type WhisperEngineHandle = {
  readonly packageId: string;
  readonly modelId: string;
  readonly revision: string;
  /** Dispose retained engine state. Does not delete verified model store. */
  dispose: () => void;
};

/**
 * Admit Whisper weights through the verified store and configure the engine
 * module so it cannot silently fetch unverified remote model bytes.
 */
export async function loadWhisperEngine(
  options: WhisperLoadOptions = {},
): Promise<WhisperEngineHandle> {
  const pkg = getLocalVoicePackage(WHISPER_PACKAGE_ID);
  const assets = await loadWhisperRuntimeAssets();

  await ensureVerifiedPackage(WHISPER_PACKAGE_ID, {
    signal: options.signal,
  });
  options.onProgress?.(pkg.files.length, pkg.files.length);

  const transformers = await import("@huggingface/transformers");
  // Fail closed: no remote model fetch; only the verified custom cache may serve.
  transformers.env.allowRemoteModels = false;
  transformers.env.useBrowserCache = false;
  transformers.env.useCustomCache = true;
  transformers.env.customCache = createVerifiedTransformersCache(WHISPER_PACKAGE_ID);

  // Import succeeds with the package's same-origin inert wasmPaths sentinel; overwrite
  // it with Vite-emitted assets before any pipeline/session is created.
  const backends = transformers.env.backends as {
    onnx?: { wasm?: { wasmPaths?: string | Record<string, string> } };
  };
  if (!backends.onnx) {
    backends.onnx = { wasm: { wasmPaths: assets.ortWasmBaseUrl } };
  } else {
    backends.onnx.wasm = backends.onnx.wasm ?? {};
    backends.onnx.wasm.wasmPaths = assets.ortWasmBaseUrl;
  }

  return {
    packageId: pkg.id,
    modelId: pkg.repo,
    revision: pkg.revision,
    dispose: () => {
      // Pipeline instances are created by later waves; nothing retained yet.
    },
  };
}

/** Worker entry helper used by the dedicated whisper worker. */
export async function importWhisperPackage(): Promise<typeof import("@huggingface/transformers")> {
  return import("@huggingface/transformers");
}
