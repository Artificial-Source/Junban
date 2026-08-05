/**
 * Dynamic-only browser VAD loader (Silero via @ricky0123/vad-web).
 * Assets are forced same-origin; no package CDN defaults are used.
 */

import { loadVadRuntimeAssets } from "../same-origin-assets.ts";

export type VadLoadOptions = {
  /** Positive grace period in ms; product UI supplies the confirmed setting later. */
  redemptionMs?: number;
};

export type VadEngineHandle = {
  readonly workletUrl: string;
  readonly modelUrl: string;
  readonly ortWasmBaseUrl: string;
  readonly MicVAD: unknown;
  dispose: () => void;
};

export async function loadVadEngine(_options: VadLoadOptions = {}): Promise<VadEngineHandle> {
  const assets = await loadVadRuntimeAssets();
  const vad = await import("@ricky0123/vad-web");

  return {
    workletUrl: assets.workletUrl,
    modelUrl: assets.modelUrl,
    ortWasmBaseUrl: assets.ortWasmBaseUrl,
    MicVAD: vad.MicVAD,
    dispose: () => {
      // Live MicVAD instances are owned by later voice UI waves.
    },
  };
}

export async function importVadPackage(): Promise<typeof import("@ricky0123/vad-web")> {
  return import("@ricky0123/vad-web");
}
