/// <reference lib="webworker" />

/**
 * Kokoro worker entry. kokoro-js is dynamic-imported only after load.
 * Owns one q8 model and serves protocol synthesize requests for af_heart only.
 */

import { LocalVoiceClientError } from "../protocol.ts";
import { installLocalVoiceWorker } from "./worker-runtime.ts";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

type KokoroHandle = {
  packageId: string;
  modelId: string;
  revision: string;
  voiceId: string;
  synthesize: (text: string) => Promise<{
    transferable: ArrayBuffer;
    sampleRate: number;
    channels: number;
  }>;
  dispose: () => Promise<void>;
};

let handle: KokoroHandle | null = null;

installLocalVoiceWorker(ctx, {
  async load() {
    const { loadKokoroEngine } = await import("../engines/load-kokoro.ts");
    handle = await loadKokoroEngine();
    return {
      packageId: handle.packageId,
      modelId: handle.modelId,
      revision: handle.revision,
      voiceId: handle.voiceId,
    };
  },
  async synthesize(text) {
    if (!handle) {
      throw new LocalVoiceClientError("not_loaded");
    }
    const audio = await handle.synthesize(text);
    return {
      format: "pcm-f32" as const,
      pcm: audio.transferable,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
    };
  },
  async dispose() {
    const current = handle;
    handle = null;
    if (current) {
      await current.dispose();
    }
  },
});
