import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InworldTTSProvider } from "../../../../src/ai/voice/adapters/inworld-tts.js";

describe("InworldTTSProvider", () => {
  let provider: InworldTTSProvider;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    provider = new InworldTTSProvider(
      "test-credential",
      "http://test/api/voice/inworld-synthesize",
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct id and name", () => {
    expect(provider.id).toBe("inworld-tts");
    expect(provider.name).toBe("Inworld AI");
    expect(provider.needsApiKey).toBe(true);
  });

  it("isAvailable returns true when API key is set", async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it("isAvailable returns false when API key is empty", async () => {
    const p = new InworldTTSProvider("");
    expect(await p.isAvailable()).toBe(false);
  });

  it("synthesizes text via fetch with correct body and headers", async () => {
    const audioBuffer = new ArrayBuffer(100);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioBuffer,
    });

    const result = await provider.synthesize("hello");

    expect(result).toBe(audioBuffer);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://test/api/voice/inworld-synthesize",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": "test-credential",
        },
      }),
    );

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.text).toBe("hello");
    expect(body.modelId).toBe("inworld-tts-1.5-max");
    expect(body.audioConfig).toEqual({ audioEncoding: "MP3" });
    expect(body.applyTextNormalization).toBe("OFF");
  });

  it("uses specified voice in request body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await provider.synthesize("test", { voice: "custom-voice-id" });

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.voiceId).toBe("custom-voice-id");
  });

  it("uses Ashley as default voice when no voice specified", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await provider.synthesize("test");

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.voiceId).toBe("Ashley");
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Server error",
    });

    await expect(provider.synthesize("hello")).rejects.toThrow("Inworld TTS error (500)");
  });

  it("getVoices fetches and maps voice list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        voices: [
          { voiceId: "voice-1", displayName: "Alice" },
          { voiceId: "voice-2", displayName: "Bob" },
        ],
      }),
    });

    const voices = await provider.getVoices();

    expect(voices).toEqual([
      { id: "voice-1", name: "Alice" },
      { id: "voice-2", name: "Bob" },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://test/api/voice/inworld-voices",
      expect.objectContaining({
        headers: { "X-Api-Key": "test-credential" },
      }),
    );
  });

  it("getVoices returns empty array on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const voices = await provider.getVoices();
    expect(voices).toEqual([]);
  });

  it("getVoices returns empty array on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const voices = await provider.getVoices();
    expect(voices).toEqual([]);
  });
});
