/**
 * Model discovery shim — delegates to provider plugins via the registry.
 * Maintains the same public API for backward compatibility with
 * vite.config.ts and api.ts imports.
 */

import { createDefaultRegistry } from "./provider.js";
import type { AIProviderConfig } from "./types.js";

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
    const registry = createDefaultRegistry();
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
  } catch {
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
  const registry = createDefaultRegistry();
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
