/**
 * Registry for voice (STT/TTS) provider plugins.
 * Same pattern as LLMProviderRegistry in src/ai/provider/registry.ts.
 */

import type { STTProviderPlugin, TTSProviderPlugin } from "./interface.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("voice-registry");

export class VoiceProviderRegistry {
  private sttProviders = new Map<string, STTProviderPlugin>();
  private ttsProviders = new Map<string, TTSProviderPlugin>();

  /** Register an STT provider. Throws if already registered. */
  registerSTT(plugin: STTProviderPlugin): void {
    if (this.sttProviders.has(plugin.id)) {
      throw new Error(`STT provider "${plugin.id}" is already registered`);
    }
    this.sttProviders.set(plugin.id, plugin);
    logger.debug("STT provider registered", { id: plugin.id, name: plugin.name });
  }

  /** Register a TTS provider. Throws if already registered. */
  registerTTS(plugin: TTSProviderPlugin): void {
    if (this.ttsProviders.has(plugin.id)) {
      throw new Error(`TTS provider "${plugin.id}" is already registered`);
    }
    this.ttsProviders.set(plugin.id, plugin);
    logger.debug("TTS provider registered", { id: plugin.id, name: plugin.name });
  }

  /** Unregister an STT provider by id. */
  unregisterSTT(id: string): void {
    this.sttProviders.delete(id);
  }

  /** Unregister a TTS provider by id. */
  unregisterTTS(id: string): void {
    this.ttsProviders.delete(id);
  }

  /** Get an STT provider by id. */
  getSTT(id: string): STTProviderPlugin | undefined {
    return this.sttProviders.get(id);
  }

  /** Get a TTS provider by id. */
  getTTS(id: string): TTSProviderPlugin | undefined {
    return this.ttsProviders.get(id);
  }

  /** List all registered STT providers. */
  listSTT(): STTProviderPlugin[] {
    return Array.from(this.sttProviders.values());
  }

  /** List all registered TTS providers. */
  listTTS(): TTSProviderPlugin[] {
    return Array.from(this.ttsProviders.values());
  }

  /** Remove all registered STT/TTS providers. */
  clear(): void {
    this.sttProviders.clear();
    this.ttsProviders.clear();
  }
}
