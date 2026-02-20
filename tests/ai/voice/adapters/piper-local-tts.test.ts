import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @mintplex-labs/piper-tts-web
const mockPredict = vi.fn();
const mockDownload = vi.fn();

vi.mock("@mintplex-labs/piper-tts-web", () => ({
  predict: (...args: any[]) => mockPredict(...args),
  download: (...args: any[]) => mockDownload(...args),
}));

import { PiperLocalTTSProvider } from "../../../../src/ai/voice/adapters/piper-local-tts.js";

describe("PiperLocalTTSProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct id, name, and needsApiKey", () => {
    const provider = new PiperLocalTTSProvider();
    expect(provider.id).toBe("piper-local");
    expect(provider.name).toBe("Piper (Local)");
    expect(provider.needsApiKey).toBe(false);
  });

  it("uses default voice as modelId", () => {
    const provider = new PiperLocalTTSProvider();
    expect(provider.modelId).toBe("en_US-hfc_female-medium");
  });

  it("uses custom default voice when provided", () => {
    const provider = new PiperLocalTTSProvider({ defaultVoice: "en_GB-alba-medium" });
    expect(provider.modelId).toBe("en_GB-alba-medium");
  });

  it("starts with idle status", () => {
    const provider = new PiperLocalTTSProvider();
    expect(provider.status).toBe("idle");
    expect(provider.progress).toBe(0);
  });

  it("returns 10 voices", async () => {
    const provider = new PiperLocalTTSProvider();
    const voices = await provider.getVoices();
    expect(voices.length).toBe(10);
    expect(voices[0]).toEqual({ id: "en_US-hfc_female-medium", name: "HFC Female (US)" });
    // Check we have UK voices
    expect(voices.some((v) => v.id.startsWith("en_GB"))).toBe(true);
  });

  it("synthesizes text to WAV ArrayBuffer", async () => {
    const wavBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" });
    mockPredict.mockResolvedValue(wavBlob);

    const provider = new PiperLocalTTSProvider();
    const result = await provider.synthesize("Hello world");

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(4);
    expect(mockPredict).toHaveBeenCalledWith(
      { text: "Hello world", voiceId: "en_US-hfc_female-medium" },
      expect.any(Function),
    );
  });

  it("uses specified voice for synthesis", async () => {
    const wavBlob = new Blob([new Uint8Array([1])], { type: "audio/wav" });
    mockPredict.mockResolvedValue(wavBlob);

    const provider = new PiperLocalTTSProvider();
    await provider.synthesize("Test", { voice: "en_US-ryan-medium" });

    expect(mockPredict).toHaveBeenCalledWith(
      { text: "Test", voiceId: "en_US-ryan-medium" },
      expect.any(Function),
    );
  });

  it("preload downloads default voice and reports progress", async () => {
    mockDownload.mockImplementation(async (_voice: any, cb: any) => {
      cb({ url: "model.onnx", loaded: 30000000, total: 60000000 });
      cb({ url: "model.onnx", loaded: 60000000, total: 60000000 });
    });

    const onStatusChange = vi.fn();
    const provider = new PiperLocalTTSProvider({ onStatusChange });

    await provider.preload();

    expect(mockDownload).toHaveBeenCalledWith("en_US-hfc_female-medium", expect.any(Function));
    expect(onStatusChange).toHaveBeenCalledWith("loading", 0);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 50);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 100);
    expect(onStatusChange).toHaveBeenCalledWith("ready", 100);
    expect(provider.status).toBe("ready");
  });

  it("sets error status when preload fails", async () => {
    mockDownload.mockRejectedValue(new Error("Network error"));

    const onStatusChange = vi.fn();
    const provider = new PiperLocalTTSProvider({ onStatusChange });

    await expect(provider.preload()).rejects.toThrow("Network error");

    expect(provider.status).toBe("error");
    expect(onStatusChange).toHaveBeenCalledWith("error", 0);
  });

  it("checkCached returns true when OPFS has onnx files", async () => {
    const mockKeys = (async function* () {
      yield "en_US-hfc_female-medium.onnx";
    })();
    const mockDir = { keys: () => mockKeys };
    const mockRoot = { getDirectoryHandle: vi.fn().mockResolvedValue(mockDir) };
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { getDirectory: vi.fn().mockResolvedValue(mockRoot) },
    });

    const provider = new PiperLocalTTSProvider();
    const cached = await provider.checkCached();

    expect(cached).toBe(true);
    vi.unstubAllGlobals();
  });

  it("checkCached returns false when OPFS piper dir is empty", async () => {
    const mockKeys = (async function* () {})();
    const mockDir = { keys: () => mockKeys };
    const mockRoot = { getDirectoryHandle: vi.fn().mockResolvedValue(mockDir) };
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { getDirectory: vi.fn().mockResolvedValue(mockRoot) },
    });

    const provider = new PiperLocalTTSProvider();
    const cached = await provider.checkCached();

    expect(cached).toBe(false);
    vi.unstubAllGlobals();
  });

  it("checkCached returns false on error", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      storage: { getDirectory: vi.fn().mockRejectedValue(new Error("OPFS unavailable")) },
    });

    const provider = new PiperLocalTTSProvider();
    const cached = await provider.checkCached();

    expect(cached).toBe(false);
    vi.unstubAllGlobals();
  });
});
