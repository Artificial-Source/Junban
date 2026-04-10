/**
 * Registry for LLM provider plugins.
 * Replaces the old AIProviderRegistry with a richer plugin-based approach.
 * Built-in providers are registered at startup; plugins can add custom providers.
 */

import type { LLMProviderPlugin, LLMExecutor } from "./interface.js";
import type { LLMCapabilities, ModelDescriptor } from "../core/capabilities.js";
import type { AIProviderConfig } from "../types.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("llm-registry");

export interface ProviderRegistration {
  plugin: LLMProviderPlugin;
  pluginId: string | null; // null = built-in
}

export class LLMProviderRegistry {
  private providers = new Map<string, ProviderRegistration>();

  /** Register a provider plugin. Throws if a provider with the same name already exists. */
  register(plugin: LLMProviderPlugin, pluginId: string | null = null): void {
    if (this.providers.has(plugin.name)) {
      throw new Error(`AI provider "${plugin.name}" is already registered`);
    }
    this.providers.set(plugin.name, { plugin, pluginId });
    logger.debug("LLM provider registered", { name: plugin.name, pluginId });
  }

  /** Unregister a provider by name. */
  unregister(name: string): void {
    this.providers.delete(name);
  }

  /** Unregister all providers from a given plugin. */
  unregisterByPlugin(pluginId: string): void {
    for (const [name, reg] of this.providers) {
      if (reg.pluginId === pluginId) {
        this.providers.delete(name);
      }
    }
  }

  /** Remove all registered providers. */
  clear(): void {
    this.providers.clear();
  }

  /** Get a provider registration by name. */
  get(name: string): ProviderRegistration | undefined {
    return this.providers.get(name);
  }

  /** Get just the plugin by name. */
  getPlugin(name: string): LLMProviderPlugin | undefined {
    return this.providers.get(name)?.plugin;
  }

  /** List all registered providers. */
  getAll(): ProviderRegistration[] {
    return Array.from(this.providers.values());
  }

  /** Create an executor for the given config. Validates API key requirements. */
  createExecutor(config: AIProviderConfig): LLMExecutor {
    const reg = this.providers.get(config.provider);
    if (!reg) {
      logger.error("Unknown AI provider", { provider: config.provider });
      throw new Error(`Unknown AI provider: ${config.provider}`);
    }
    logger.debug("Creating LLM executor", { provider: config.provider, model: config.model });
    const hasOAuthToken = config.authType === "oauth" && !!config.oauthToken;
    if (reg.plugin.needsApiKey && !config.apiKey && !hasOAuthToken) {
      throw new Error(`${reg.plugin.displayName} requires an API key`);
    }
    return reg.plugin.createExecutor(config);
  }

  /** Discover models for a provider. */
  async discoverModels(providerName: string, config: AIProviderConfig): Promise<ModelDescriptor[]> {
    logger.debug("Discovering models", { provider: providerName });
    const reg = this.providers.get(providerName);
    if (!reg) return [];
    try {
      return await reg.plugin.discoverModels(config);
    } catch {
      return [];
    }
  }

  /** Load a model on a provider (local providers). */
  async loadModel(providerName: string, modelKey: string, config: AIProviderConfig): Promise<void> {
    const reg = this.providers.get(providerName);
    if (!reg?.plugin.loadModel) {
      throw new Error(`Provider "${providerName}" does not support model loading`);
    }
    await reg.plugin.loadModel(modelKey, config);
  }

  /** Get capabilities for a model from its provider's executor. */
  getCapabilities(
    providerName: string,
    modelId: string,
    config: AIProviderConfig,
  ): LLMCapabilities {
    const reg = this.providers.get(providerName);
    if (!reg) {
      return { streaming: true, toolCalling: true, vision: false, structuredOutput: false };
    }
    const executor = reg.plugin.createExecutor(config);
    return executor.getCapabilities(modelId);
  }
}
