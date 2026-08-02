/**
 * Same-origin URL helpers for worklet / ORT / phonemizer support assets.
 *
 * These imports are only reachable from dynamic engine loaders so ordinary
 * application startup does not fetch them.
 */

export type WhisperRuntimeAssets = {
  ortWasmBaseUrl: string;
};

export type VadRuntimeAssets = {
  workletUrl: string;
  modelUrl: string;
  ortWasmBaseUrl: string;
};

export type PiperRuntimeAssets = {
  onnxWasmBaseUrl: string;
  piperWasmUrl: string;
  piperDataUrl: string;
};

export type KokoroRuntimeAssets = {
  ortWasmBaseUrl: string;
};

function directoryOfAssetUrl(assetUrl: string): string {
  return assetUrl.replace(/[^/]+$/, "");
}

/** Resolve Whisper/transformers ORT assets shipped beside the package. */
export async function loadWhisperRuntimeAssets(): Promise<WhisperRuntimeAssets> {
  const { default: wasmUrl } = await import("@junban/ort-transformers-wasm?url");
  return { ortWasmBaseUrl: directoryOfAssetUrl(wasmUrl) };
}

/** Resolve VAD worklet, Silero v5 model, and ORT wasm from package assets. */
export async function loadVadRuntimeAssets(): Promise<VadRuntimeAssets> {
  const [{ default: workletUrl }, { default: modelUrl }, { default: wasmUrl }] = await Promise.all([
    import("@ricky0123/vad-web/dist/vad.worklet.bundle.min.js?url"),
    import("@ricky0123/vad-web/dist/silero_vad_v5.onnx?url"),
    import("@junban/ort-vad-wasm?url"),
  ]);
  return {
    workletUrl,
    modelUrl,
    ortWasmBaseUrl: directoryOfAssetUrl(wasmUrl),
  };
}

/** Resolve Piper phonemize + ORT assets from exact package versions. */
export async function loadPiperRuntimeAssets(): Promise<PiperRuntimeAssets> {
  const [{ default: piperWasmUrl }, { default: piperDataUrl }, { default: wasmUrl }] =
    await Promise.all([
      import("@diffusionstudio/piper-wasm/build/piper_phonemize.wasm?url"),
      import("@diffusionstudio/piper-wasm/build/piper_phonemize.data?url"),
      import("@junban/ort-vad-wasm?url"),
    ]);
  return {
    onnxWasmBaseUrl: directoryOfAssetUrl(wasmUrl),
    piperWasmUrl,
    piperDataUrl,
  };
}

/** Kokoro uses the same transformers ORT assets as Whisper. */
export async function loadKokoroRuntimeAssets(): Promise<KokoroRuntimeAssets> {
  const whisper = await loadWhisperRuntimeAssets();
  return { ortWasmBaseUrl: whisper.ortWasmBaseUrl };
}
