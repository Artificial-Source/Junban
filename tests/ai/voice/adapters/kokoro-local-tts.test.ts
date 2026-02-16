import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock kokoro-js
const mockFromPretrained = vi.fn();
vi.mock("kokoro-js", () => ({
  KokoroTTS: {
    from_pretrained: (...args: any[]) => mockFromPretrained(...args),
  },
}));

import { KokoroLocalTTSProvider } from "../../../../src/ai/voice/adapters/kokoro-local-tts.js";

describe("KokoroLocalTTSProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct id, name, and needsApiKey", () => {
    const provider = new KokoroLocalTTSProvider();
    expect(provider.id).toBe("kokoro-local");
    expect(provider.name).toBe("Kokoro (Local)");
    expect(provider.needsApiKey).toBe(false);
  });

  it("uses default model ID", () => {
    const provider = new KokoroLocalTTSProvider();
    expect(provider.modelId).toBe("onnx-community/Kokoro-82M-v1.0-ONNX");
  });

  it("uses custom model ID when provided", () => {
    const provider = new KokoroLocalTTSProvider({ modelId: "custom/tts" });
    expect(provider.modelId).toBe("custom/tts");
  });

  it("starts with idle status", () => {
    const provider = new KokoroLocalTTSProvider();
    expect(provider.status).toBe("idle");
    expect(provider.progress).toBe(0);
  });

  it("returns 21 voices", async () => {
    const provider = new KokoroLocalTTSProvider();
    const voices = await provider.getVoices();
    expect(voices.length).toBe(21);
    expect(voices[0]).toEqual({ id: "af_heart", name: "Heart (Female)" });
    // Check we have both genders and accents
    expect(voices.some((v) => v.id.startsWith("am_"))).toBe(true);
    expect(voices.some((v) => v.id.startsWith("bf_"))).toBe(true);
    expect(voices.some((v) => v.id.startsWith("bm_"))).toBe(true);
  });

  it("loads model and synthesizes text to WAV", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      audio: new Float32Array([0.1, -0.5, 0.3, 0.0]),
      sampling_rate: 24000,
    });
    mockFromPretrained.mockResolvedValue({ generate: mockGenerate });

    const onStatusChange = vi.fn();
    const provider = new KokoroLocalTTSProvider({ onStatusChange });

    const result = await provider.synthesize("Hello world");

    expect(result).toBeInstanceOf(ArrayBuffer);
    // WAV header is 44 bytes + 4 samples * 2 bytes = 52 bytes
    expect(result.byteLength).toBe(52);

    expect(mockFromPretrained).toHaveBeenCalledWith(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      expect.objectContaining({ device: "wasm" }),
    );
    expect(mockGenerate).toHaveBeenCalledWith("Hello world", { voice: "af_heart" });
    expect(provider.status).toBe("ready");
    expect(onStatusChange).toHaveBeenCalledWith("loading", 0);
    expect(onStatusChange).toHaveBeenCalledWith("ready", 100);
  });

  it("uses specified voice", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      audio: new Float32Array([0.1]),
      sampling_rate: 24000,
    });
    mockFromPretrained.mockResolvedValue({ generate: mockGenerate });

    const provider = new KokoroLocalTTSProvider();
    await provider.synthesize("Test", { voice: "am_adam" });

    expect(mockGenerate).toHaveBeenCalledWith("Test", { voice: "am_adam" });
  });

  it("reports progress during model loading", async () => {
    mockFromPretrained.mockImplementation(async (_model: any, opts: any) => {
      const cb = opts.progress_callback;
      cb({ status: "progress", progress: 30 });
      cb({ status: "progress", progress: 60 });
      cb({ status: "progress", progress: 100 });
      return { generate: vi.fn().mockResolvedValue({ audio: new Float32Array(0), sampling_rate: 24000 }) };
    });

    const onStatusChange = vi.fn();
    const provider = new KokoroLocalTTSProvider({ onStatusChange });

    await provider.synthesize("Hello");

    expect(onStatusChange).toHaveBeenCalledWith("loading", 30);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 60);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 100);
  });

  it("sets error status when model loading fails", async () => {
    mockFromPretrained.mockRejectedValue(new Error("Download failed"));

    const onStatusChange = vi.fn();
    const provider = new KokoroLocalTTSProvider({ onStatusChange });

    await expect(provider.preload()).rejects.toThrow("Download failed");

    expect(provider.status).toBe("error");
    expect(onStatusChange).toHaveBeenCalledWith("error", 0);
  });

  it("reuses loaded model on subsequent calls", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      audio: new Float32Array([0.1]),
      sampling_rate: 24000,
    });
    mockFromPretrained.mockResolvedValue({ generate: mockGenerate });

    const provider = new KokoroLocalTTSProvider();
    await provider.synthesize("First");
    await provider.synthesize("Second");

    expect(mockFromPretrained).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});
