/// <reference lib="webworker" />

/**
 * Whisper worker entry. Engine packages are dynamic-imported only after load.
 * Owns one q4 ASR pipeline and serves protocol transcribe requests.
 */

import {
  LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ,
  LocalVoiceClientError,
  validateWhisperPcm,
} from "../protocol.ts";
import { installLocalVoiceWorker } from "./worker-runtime.ts";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

type WhisperHandle = {
  packageId: string;
  modelId: string;
  revision: string;
  transcribe: (samples: Float32Array) => Promise<string>;
  dispose: () => Promise<void>;
};

let handle: WhisperHandle | null = null;

installLocalVoiceWorker(ctx, {
  async load() {
    const { loadWhisperEngine } = await import("../engines/load-whisper.ts");
    handle = await loadWhisperEngine();
    return {
      packageId: handle.packageId,
      modelId: handle.modelId,
      revision: handle.revision,
    };
  },
  async transcribe(pcm, sampleRate) {
    if (!handle) {
      throw new LocalVoiceClientError("not_loaded");
    }
    const validated = validateWhisperPcm(pcm, sampleRate);
    if (!validated.ok) {
      throw new LocalVoiceClientError(validated.code);
    }
    // Defensive: protocol already requires 16 kHz; keep the constant visible.
    if (sampleRate !== LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ) {
      throw new LocalVoiceClientError("invalid_audio");
    }
    return handle.transcribe(validated.samples);
  },
  async dispose() {
    const current = handle;
    handle = null;
    if (current) {
      await current.dispose();
    }
  },
});
