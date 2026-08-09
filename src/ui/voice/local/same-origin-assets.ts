/**
 * Same-origin URL helpers for worklet / ORT / phonemizer support assets.
 *
 * These imports are only reachable from dynamic engine loaders so ordinary
 * application startup does not fetch them.
 *
 * ORT 1.22+ accepts wasmPaths as either a directory prefix string or
 * `{ mjs, wasm }` absolute URLs. Vite content-hashes filenames, so Whisper
 * and Kokoro must use the object form pointing at the emitted assets.
 */

/** onnxruntime-web wasmPaths object form (hashed same-origin URLs). */
export type OrtWasmPaths = {
  readonly mjs: string;
  readonly wasm: string;
};

export type WhisperRuntimeAssets = {
  /** @deprecated Prefer ortWasmPaths — directory prefixes break under hashed builds. */
  ortWasmBaseUrl: string;
  ortWasmPaths: OrtWasmPaths;
};

export type VadRuntimeAssets = {
  workletUrl: string;
  modelUrl: string;
  ortWasmBaseUrl: string;
  ortWasmPaths: OrtWasmPaths;
};

export type PiperRuntimeAssets = {
  onnxWasmBaseUrl: string;
  ortWasmPaths: OrtWasmPaths;
  piperWasmUrl: string;
  piperDataUrl: string;
};

export type KokoroRuntimeAssets = {
  ortWasmBaseUrl: string;
  ortWasmPaths: OrtWasmPaths;
};

function directoryOfAssetUrl(assetUrl: string): string {
  return assetUrl.replace(/[^/]+$/, "");
}

/** Resolve Whisper/transformers ORT assets shipped beside the package. */
export async function loadWhisperRuntimeAssets(): Promise<WhisperRuntimeAssets> {
  const [{ default: wasmUrl }, { default: mjsUrl }] = await Promise.all([
    import("@junban/ort-transformers-wasm?url"),
    import("@junban/ort-transformers-mjs?url"),
  ]);
  return {
    ortWasmBaseUrl: directoryOfAssetUrl(wasmUrl),
    ortWasmPaths: { mjs: mjsUrl, wasm: wasmUrl },
  };
}

/** Resolve VAD worklet, Silero v5 model, and ORT wasm from package assets. */
export async function loadVadRuntimeAssets(): Promise<VadRuntimeAssets> {
  const [
    { default: workletUrl },
    { default: modelUrl },
    { default: wasmUrl },
    { default: mjsUrl },
  ] = await Promise.all([
    import("@ricky0123/vad-web/dist/vad.worklet.bundle.min.js?url"),
    import("@ricky0123/vad-web/dist/silero_vad_v5.onnx?url"),
    import("@junban/ort-vad-wasm?url"),
    import("@junban/ort-vad-mjs?url"),
  ]);
  return {
    workletUrl,
    modelUrl,
    ortWasmBaseUrl: directoryOfAssetUrl(wasmUrl),
    ortWasmPaths: { mjs: mjsUrl, wasm: wasmUrl },
  };
}

/** Resolve Piper phonemize + ORT assets from exact package versions. */
export async function loadPiperRuntimeAssets(): Promise<PiperRuntimeAssets> {
  const [
    { default: piperWasmUrl },
    { default: piperDataUrl },
    { default: wasmUrl },
    { default: mjsUrl },
  ] = await Promise.all([
    import("@diffusionstudio/piper-wasm/build/piper_phonemize.wasm?url"),
    import("@diffusionstudio/piper-wasm/build/piper_phonemize.data?url"),
    import("@junban/ort-vad-wasm?url"),
    import("@junban/ort-vad-mjs?url"),
  ]);
  return {
    onnxWasmBaseUrl: directoryOfAssetUrl(wasmUrl),
    ortWasmPaths: { mjs: mjsUrl, wasm: wasmUrl },
    piperWasmUrl,
    piperDataUrl,
  };
}

/** Kokoro uses the same transformers ORT assets as Whisper. */
export async function loadKokoroRuntimeAssets(): Promise<KokoroRuntimeAssets> {
  const whisper = await loadWhisperRuntimeAssets();
  return {
    ortWasmBaseUrl: whisper.ortWasmBaseUrl,
    ortWasmPaths: whisper.ortWasmPaths,
  };
}
