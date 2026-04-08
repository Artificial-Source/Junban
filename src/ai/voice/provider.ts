/**
 * Voice provider factory.
 * Creates a VoiceProviderRegistry with default providers registered.
 */

import { VoiceProviderRegistry } from "./registry.js";
import { BrowserSTTProvider } from "./adapters/browser-stt.js";
import { BrowserTTSProvider } from "./adapters/browser-tts.js";
import { GroqSTTProvider } from "./adapters/groq-stt.js";
import { GroqTTSProvider } from "./adapters/groq-tts.js";
import { InworldTTSProvider } from "./adapters/inworld-tts.js";

export interface VoiceProviderConfig {
  groqApiKey?: string;
  inworldApiKey?: string;
}

const LOCAL_STT_PROVIDER_ID = "whisper-local-stt";
const LOCAL_TTS_PROVIDER_IDS = ["piper-local-tts", "kokoro-local-tts"] as const;

export function hasLocalVoiceProviders(registry: VoiceProviderRegistry): boolean {
  return (
    registry.listSTT().some((provider) => provider.id === LOCAL_STT_PROVIDER_ID) &&
    LOCAL_TTS_PROVIDER_IDS.every((id) => registry.listTTS().some((provider) => provider.id === id))
  );
}

/** Create a VoiceProviderRegistry with built-in providers. */
export function createDefaultVoiceRegistry(config?: VoiceProviderConfig): VoiceProviderRegistry {
  const registry = new VoiceProviderRegistry();

  // Always register browser fallbacks
  registry.registerSTT(new BrowserSTTProvider());
  registry.registerTTS(new BrowserTTSProvider());

  // Register Groq providers when API key is available
  if (config?.groqApiKey) {
    registry.registerSTT(new GroqSTTProvider(config.groqApiKey));
    registry.registerTTS(new GroqTTSProvider(config.groqApiKey));
  }

  // Always register Inworld TTS (shows in dropdown; requires API key to function)
  registry.registerTTS(new InworldTTSProvider(config?.inworldApiKey ?? ""));

  return registry;
}

export async function registerLocalVoiceProviders(
  registry: VoiceProviderRegistry,
): Promise<VoiceProviderRegistry> {
  if (hasLocalVoiceProviders(registry)) {
    return registry;
  }

  const [{ WhisperLocalSTTProvider }, { PiperLocalTTSProvider }, { KokoroLocalTTSProvider }] =
    await Promise.all([
      import("./adapters/whisper-local-stt.js"),
      import("./adapters/piper-local-tts.js"),
      import("./adapters/kokoro-local-tts.js"),
    ]);

  if (!registry.listSTT().some((provider) => provider.id === LOCAL_STT_PROVIDER_ID)) {
    registry.registerSTT(new WhisperLocalSTTProvider());
  }
  if (!registry.listTTS().some((provider) => provider.id === "piper-local-tts")) {
    registry.registerTTS(new PiperLocalTTSProvider());
  }
  if (!registry.listTTS().some((provider) => provider.id === "kokoro-local-tts")) {
    registry.registerTTS(new KokoroLocalTTSProvider());
  }

  return registry;
}
