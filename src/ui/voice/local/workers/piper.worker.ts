/// <reference lib="webworker" />

/**
 * Piper worker entry. The Piper package is dynamic-imported only after load.
 * Seeds verified LJ Speech into patched OPFS and owns one TtsSession.
 */

import { LocalVoiceClientError } from "../protocol.ts";
import { installLocalVoiceWorker } from "./worker-runtime.ts";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

type PiperHandle = {
  packageId: string;
  voiceId: string;
  revision: string;
  synthesize: (text: string) => Promise<{
    wav: ArrayBuffer;
    sampleRate: number;
    channels: number;
  }>;
  dispose: () => Promise<void>;
};

let handle: PiperHandle | null = null;

installLocalVoiceWorker(ctx, {
  async load() {
    const { loadPiperEngine } = await import("../engines/load-piper.ts");
    handle = await loadPiperEngine();
    return {
      packageId: handle.packageId,
      modelId: handle.voiceId,
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
      format: "wav" as const,
      wav: audio.wav,
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
