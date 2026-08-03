/**
 * Lazy VAD loader bridge.
 *
 * Uses the same same-origin worklet/model/ORT asset URLs as
 * `local/engines/load-vad.ts`, but does not import `same-origin-assets.ts`
 * (which also references Whisper/Kokoro/Piper ORT paths and would pull those
 * into the AI chat graph). Engine packages stay dynamic-only.
 */

export type VadLoaderHandle = {
  readonly workletUrl: string;
  readonly modelUrl: string;
  readonly ortWasmBaseUrl: string;
  readonly MicVAD: {
    new: (options: Record<string, unknown>) => Promise<{
      start: () => Promise<void>;
      pause: () => Promise<void>;
      destroy: () => Promise<void>;
      listening?: boolean;
    }>;
  };
  dispose: () => void;
};

function directoryOfAssetUrl(assetUrl: string): string {
  return assetUrl.replace(/[^/]+$/, "");
}

/**
 * Load Silero v5 MicVAD + same-origin support assets after an explicit gesture.
 * Never call at module evaluation / ordinary startup.
 */
export async function loadVadEngineBridge(): Promise<VadLoaderHandle> {
  const [{ default: workletUrl }, { default: modelUrl }, { default: wasmUrl }, vad] =
    await Promise.all([
      import("@ricky0123/vad-web/dist/vad.worklet.bundle.min.js?url"),
      import("@ricky0123/vad-web/dist/silero_vad_v5.onnx?url"),
      import("@junban/ort-vad-wasm?url"),
      import("@ricky0123/vad-web"),
    ]);

  return {
    workletUrl,
    modelUrl,
    ortWasmBaseUrl: directoryOfAssetUrl(wasmUrl),
    MicVAD: vad.MicVAD as VadLoaderHandle["MicVAD"],
    dispose: () => {
      // Live MicVAD instances are owned by vad-session.
    },
  };
}
