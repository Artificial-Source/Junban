import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @huggingface/transformers
const mockPipeline = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: any[]) => mockPipeline(...args),
}));

import { WhisperLocalSTTProvider } from "../../../../src/ai/voice/adapters/whisper-local-stt.js";

function stubAudioAPIs(channelData = new Float32Array([0.1, -0.2, 0.3])) {
  const mockAudioBuffer = {
    duration: 1.0,
    sampleRate: 16000,
    getChannelData: () => channelData,
  };
  const mockRendered = { getChannelData: () => channelData };

  // Use class syntax so `new AudioContext()` works
  class MockAudioContext {
    decodeAudioData = vi.fn().mockResolvedValue(mockAudioBuffer);
    close = vi.fn().mockResolvedValue(undefined);
  }
  class MockOfflineAudioContext {
    destination = {};
    createBufferSource() {
      return {
        buffer: null as any,
        connect: vi.fn(),
        start: vi.fn(),
      };
    }
    startRendering = vi.fn().mockResolvedValue(mockRendered);
  }

  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("OfflineAudioContext", MockOfflineAudioContext);
}

describe("WhisperLocalSTTProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has correct id, name, and needsApiKey", () => {
    const provider = new WhisperLocalSTTProvider();
    expect(provider.id).toBe("whisper-local");
    expect(provider.name).toBe("Whisper (Local)");
    expect(provider.needsApiKey).toBe(false);
  });

  it("uses default model ID", () => {
    const provider = new WhisperLocalSTTProvider();
    expect(provider.modelId).toBe("onnx-community/whisper-tiny.en");
  });

  it("uses custom model ID when provided", () => {
    const provider = new WhisperLocalSTTProvider({ modelId: "custom/model" });
    expect(provider.modelId).toBe("custom/model");
  });

  it("starts with idle status", () => {
    const provider = new WhisperLocalSTTProvider();
    expect(provider.status).toBe("idle");
    expect(provider.progress).toBe(0);
  });

  it("loads model on first transcribe and calls pipeline", async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: "hello world" });
    mockPipeline.mockResolvedValue(mockTranscribe);
    stubAudioAPIs();

    const onStatusChange = vi.fn();
    const provider = new WhisperLocalSTTProvider({ onStatusChange });

    const blob = new Blob(["audio data"], { type: "audio/wav" });
    const result = await provider.transcribe(blob);

    expect(result).toBe("hello world");
    expect(mockPipeline).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      "onnx-community/whisper-tiny.en",
      expect.objectContaining({ dtype: "q4", device: "wasm" }),
    );
    expect(mockTranscribe).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ return_timestamps: false }),
    );
    expect(provider.status).toBe("ready");
    expect(provider.progress).toBe(100);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 0);
    expect(onStatusChange).toHaveBeenCalledWith("ready", 100);
  });

  it("reports progress during model loading", async () => {
    mockPipeline.mockImplementation(async (_task: any, _model: any, opts: any) => {
      const cb = opts.progress_callback;
      cb({ status: "progress", progress: 25 });
      cb({ status: "progress", progress: 50 });
      cb({ status: "progress", progress: 100 });
      return vi.fn().mockResolvedValue({ text: "" });
    });
    stubAudioAPIs(new Float32Array(0));

    const onStatusChange = vi.fn();
    const provider = new WhisperLocalSTTProvider({ onStatusChange });

    await provider.transcribe(new Blob(["audio"]));

    expect(onStatusChange).toHaveBeenCalledWith("loading", 25);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 50);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 100);
  });

  it("sets error status when model loading fails", async () => {
    mockPipeline.mockRejectedValue(new Error("Network error"));

    const onStatusChange = vi.fn();
    const provider = new WhisperLocalSTTProvider({ onStatusChange });

    await expect(provider.preload()).rejects.toThrow("Network error");

    expect(provider.status).toBe("error");
    expect(onStatusChange).toHaveBeenCalledWith("error", 0);
  });

  it("reuses loaded model on subsequent calls", async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: "hello" });
    mockPipeline.mockResolvedValue(mockTranscribe);
    stubAudioAPIs(new Float32Array(0));

    const provider = new WhisperLocalSTTProvider();
    await provider.transcribe(new Blob(["a"]));
    await provider.transcribe(new Blob(["b"]));

    // Pipeline should only be created once
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
  });
});
