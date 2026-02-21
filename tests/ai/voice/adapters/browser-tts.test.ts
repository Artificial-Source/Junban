import { describe, it, expect, beforeEach } from "vitest";
import { BrowserTTSProvider } from "../../../../src/ai/voice/adapters/browser-tts.js";

describe("BrowserTTSProvider", () => {
  let provider: BrowserTTSProvider;

  beforeEach(() => {
    provider = new BrowserTTSProvider();
  });

  it("has correct id and name", () => {
    expect(provider.id).toBe("browser-tts");
    expect(provider.name).toBe("Browser (Speech Synthesis)");
    expect(provider.needsApiKey).toBe(false);
  });

  it("isAvailable returns false when speechSynthesis is not available", async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it("isAvailable returns true when speechSynthesis is available", async () => {
    (globalThis as any).window = { speechSynthesis: {} };
    const p = new BrowserTTSProvider();
    const available = await p.isAvailable();
    expect(available).toBe(true);
    delete (globalThis as any).window.speechSynthesis;
  });

  it("getVoices returns empty when speechSynthesis not available", async () => {
    const voices = await provider.getVoices();
    expect(voices).toEqual([]);
  });

  it("speakDirect rejects when speechSynthesis not available", async () => {
    await expect(provider.speakDirect("hello")).rejects.toThrow("not supported");
  });
});
