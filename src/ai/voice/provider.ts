/**
 * Voice provider factory.
 * Creates a VoiceProviderRegistry with default providers registered.
 */

import { VoiceProviderRegistry } from "./registry.js";
import { BrowserSTTProvider } from "./adapters/browser-stt.js";
import { BrowserTTSProvider } from "./adapters/browser-tts.js";
import { GroqSTTProvider } from "./adapters/groq-stt.js";
import { GroqTTSProvider } from "./adapters/groq-tts.js";
import { WhisperLocalSTTProvider } from "./adapters/whisper-local-stt.js";
import { KokoroLocalTTSProvider } from "./adapters/kokoro-local-tts.js";

export interface VoiceProviderConfig {
  groqApiKey?: string;
}

/** Create a VoiceProviderRegistry with built-in providers. */
export function createDefaultVoiceRegistry(config?: VoiceProviderConfig): VoiceProviderRegistry {
  const registry = new VoiceProviderRegistry();

  // Always register browser fallbacks
  registry.registerSTT(new BrowserSTTProvider());
  registry.registerTTS(new BrowserTTSProvider());

  // Always register local providers (no API key needed, models download on first use)
  registry.registerSTT(new WhisperLocalSTTProvider());
  registry.registerTTS(new KokoroLocalTTSProvider());

  // Register Groq providers when API key is available
  if (config?.groqApiKey) {
    registry.registerSTT(new GroqSTTProvider(config.groqApiKey));
    registry.registerTTS(new GroqTTSProvider(config.groqApiKey));
  }

  return registry;
}
