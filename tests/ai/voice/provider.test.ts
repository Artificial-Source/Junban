import { describe, expect, it } from "vitest";
import { createDefaultVoiceRegistry } from "../../../src/ai/voice/provider.js";

describe("createDefaultVoiceRegistry", () => {
  it("does not register Inworld TTS when API key is missing", () => {
    const registry = createDefaultVoiceRegistry();
    expect(registry.getTTS("inworld-tts")).toBeUndefined();
  });

  it("registers Inworld TTS when API key is configured", () => {
    const registry = createDefaultVoiceRegistry({ inworldApiKey: "inworld-key" });
    expect(registry.getTTS("inworld-tts")).toBeDefined();
  });
});
