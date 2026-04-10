/**
 * Model discovery shim — delegates to provider plugins via the registry.
 * Maintains the same public API for backward compatibility with
 * vite.config.ts and api.ts imports.
 */

import type { AIProviderConfig } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("model-discovery");

async function createRegistry() {
  const { createDefaultRegistryAsync } = await import("./provider.js");
  return createDefaultRegistryAsync();
}

export interface ModelInfo {
  id: string;
  label: string;
  loaded: boolean;
}

/**
 * Fetch available models for a provider.
 * Delegates to the provider plugin's discoverModels() method.
 */
export async function fetchAvailableModels(
  providerName: string,
  config: { apiKey?: string; baseUrl?: string },
): Promise<ModelInfo[]> {
  try {
    const registry = await createRegistry();
    const providerConfig: AIProviderConfig = {
      provider: providerName,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    const descriptors = await registry.discoverModels(providerName, providerConfig);
    return descriptors.map((d) => ({
      id: d.id,
      label: d.label,
      loaded: d.loaded,
    }));
  } catch (err) {
    logger.warn("Failed to fetch available models", {
      provider: providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Load a model in LM Studio (or any provider supporting model loading).
 */
export async function loadLMStudioModel(
  modelKey: string,
  baseUrl: string,
  apiKey?: string,
): Promise<string> {
  const registry = await createRegistry();
  const config: AIProviderConfig = {
    provider: "lmstudio",
    baseUrl,
    apiKey,
  };
  await registry.loadModel("lmstudio", modelKey, config);
  return modelKey;
}

/**
 * Unload a model from LM Studio.
 */
export async function unloadLMStudioModel(
  modelKey: string,
  baseUrl: string,
  apiKey?: string,
): Promise<void> {
  const { unloadLMStudioModel: unload } = await import("./provider/adapters/lmstudio.js");
  const config: AIProviderConfig = {
    provider: "lmstudio",
    baseUrl,
    apiKey,
  };
  await unload(modelKey, config);
}
