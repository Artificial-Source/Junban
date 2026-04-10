import { describe, it, expect } from "vitest";
import { VoiceProviderRegistry } from "../../../src/ai/voice/registry.js";
import type { STTProviderPlugin, TTSProviderPlugin } from "../../../src/ai/voice/interface.js";

function createTestSTT(id: string): STTProviderPlugin {
  return {
    id,
    name: `Test STT ${id}`,
    needsApiKey: false,
    transcribe: async () => "hello",
    isAvailable: async () => true,
  };
}

function createTestTTS(id: string): TTSProviderPlugin {
  return {
    id,
    name: `Test TTS ${id}`,
    needsApiKey: false,
    synthesize: async () => new ArrayBuffer(0),
    isAvailable: async () => true,
  };
}

describe("VoiceProviderRegistry", () => {
  describe("STT", () => {
    it("registers and retrieves an STT provider", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerSTT(createTestSTT("test"));
      expect(registry.getSTT("test")).toBeDefined();
      expect(registry.getSTT("test")!.name).toBe("Test STT test");
    });

    it("lists all STT providers", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerSTT(createTestSTT("a"));
      registry.registerSTT(createTestSTT("b"));
      expect(registry.listSTT()).toHaveLength(2);
    });

    it("throws on duplicate STT registration", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerSTT(createTestSTT("dup"));
      expect(() => registry.registerSTT(createTestSTT("dup"))).toThrow("already registered");
    });

    it("unregisters an STT provider", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerSTT(createTestSTT("remove"));
      registry.unregisterSTT("remove");
      expect(registry.getSTT("remove")).toBeUndefined();
    });

    it("returns undefined for unknown STT provider", () => {
      const registry = new VoiceProviderRegistry();
      expect(registry.getSTT("nope")).toBeUndefined();
    });
  });

  describe("TTS", () => {
    it("registers and retrieves a TTS provider", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerTTS(createTestTTS("test"));
      expect(registry.getTTS("test")).toBeDefined();
      expect(registry.getTTS("test")!.name).toBe("Test TTS test");
    });

    it("lists all TTS providers", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerTTS(createTestTTS("a"));
      registry.registerTTS(createTestTTS("b"));
      expect(registry.listTTS()).toHaveLength(2);
    });

    it("throws on duplicate TTS registration", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerTTS(createTestTTS("dup"));
      expect(() => registry.registerTTS(createTestTTS("dup"))).toThrow("already registered");
    });

    it("unregisters a TTS provider", () => {
      const registry = new VoiceProviderRegistry();
      registry.registerTTS(createTestTTS("remove"));
      registry.unregisterTTS("remove");
      expect(registry.getTTS("remove")).toBeUndefined();
    });

    it("returns undefined for unknown TTS provider", () => {
      const registry = new VoiceProviderRegistry();
      expect(registry.getTTS("nope")).toBeUndefined();
    });
  });

  it("manages STT and TTS independently", () => {
    const registry = new VoiceProviderRegistry();
    registry.registerSTT(createTestSTT("shared-id"));
    registry.registerTTS(createTestTTS("shared-id"));
    expect(registry.getSTT("shared-id")).toBeDefined();
    expect(registry.getTTS("shared-id")).toBeDefined();
    registry.unregisterSTT("shared-id");
    expect(registry.getSTT("shared-id")).toBeUndefined();
    expect(registry.getTTS("shared-id")).toBeDefined();
  });

  it("clears all registered providers", () => {
    const registry = new VoiceProviderRegistry();
    registry.registerSTT(createTestSTT("stt-a"));
    registry.registerTTS(createTestTTS("tts-a"));

    registry.clear();

    expect(registry.listSTT()).toHaveLength(0);
    expect(registry.listTTS()).toHaveLength(0);
  });
});
