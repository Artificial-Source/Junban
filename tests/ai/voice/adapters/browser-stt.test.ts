import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserSTTProvider } from "../../../../src/ai/voice/adapters/browser-stt.js";

describe("BrowserSTTProvider", () => {
  let provider: BrowserSTTProvider;

  beforeEach(() => {
    provider = new BrowserSTTProvider();
  });

  it("has correct id and name", () => {
    expect(provider.id).toBe("browser-stt");
    expect(provider.name).toBe("Browser (Web Speech API)");
    expect(provider.needsApiKey).toBe(false);
  });

  it("transcribe() throws (blob mode not supported)", async () => {
    const blob = new Blob(["test"], { type: "audio/wav" });
    await expect(provider.transcribe(blob)).rejects.toThrow(
      "does not support transcribing audio blobs",
    );
  });

  it("isAvailable returns false when SpeechRecognition is not available", async () => {
    // In Node/jsdom, SpeechRecognition doesn't exist
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it("isAvailable returns true when SpeechRecognition is available", async () => {
    // Mock the global
    (globalThis as any).window = {
      SpeechRecognition: vi.fn(),
    };
    const p = new BrowserSTTProvider();
    const available = await p.isAvailable();
    expect(available).toBe(true);
    delete (globalThis as any).window.SpeechRecognition;
  });

  it("startLiveRecognition rejects when SpeechRecognition not supported", async () => {
    await expect(provider.startLiveRecognition()).rejects.toThrow("not supported");
  });
});
