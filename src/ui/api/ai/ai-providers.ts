import {
  useDirectServices,
  BASE,
  buildApiUrl,
  handleResponse,
  handleVoidResponse,
} from "../helpers.js";
import { getServices } from "../direct-services.js";
import type { AIProviderInfo, ModelDiscoveryInfo } from "./ai-types.js";
import { DEFAULT_LMSTUDIO_BASE_URL } from "../../../config/defaults.js";
import { getSecureSetting } from "../../../storage/encrypted-settings.js";

export async function listAIProviders(): Promise<AIProviderInfo[]> {
  if (useDirectServices()) {
    const svc = await getServices();
    const ai = await svc.getAIRuntime();
    return ai.aiProviderRegistry.getAll().map((r) => ({
      name: r.plugin.name,
      displayName: r.plugin.displayName,
      needsApiKey: r.plugin.needsApiKey,
      optionalApiKey: r.plugin.optionalApiKey ?? false,
      supportsOAuth: r.plugin.supportsOAuth ?? false,
      defaultModel: r.plugin.defaultModel,
      defaultBaseUrl: r.plugin.defaultBaseUrl,
      showBaseUrl: r.plugin.showBaseUrl ?? false,
      pluginId: r.pluginId,
    }));
  }
  const res = await fetch(`${BASE}/ai/providers`);
  return handleResponse<AIProviderInfo[]>(res);
}

export async function fetchModels(
  providerName: string,
  baseUrl?: string,
): Promise<ModelDiscoveryInfo[]> {
  if (useDirectServices()) {
    const svc = await getServices();
    const apiKey = await getSecureSetting(svc.storage, "ai_api_key");
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const { fetchAvailableModels } = await import("../../../ai/model-discovery.js");
    return fetchAvailableModels(providerName, {
      apiKey: apiKey ?? undefined,
      baseUrl: baseUrl || baseUrlSetting?.value,
    });
  }
  const res = await fetch(
    buildApiUrl(`/ai/providers/${encodeURIComponent(providerName)}/models`, {
      baseUrl,
    }),
  );
  const data = await handleResponse<{ models: ModelDiscoveryInfo[] }>(res);
  return data.models;
}

export async function loadModel(
  providerName: string,
  modelKey: string,
  baseUrl?: string,
): Promise<void> {
  if (useDirectServices()) {
    const svc = await getServices();
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const apiKey = await getSecureSetting(svc.storage, "ai_api_key");
    if (providerName === "lmstudio") {
      const { loadLMStudioModel } = await import("../../../ai/model-discovery.js");
      await loadLMStudioModel(
        modelKey,
        baseUrl || baseUrlSetting?.value || DEFAULT_LMSTUDIO_BASE_URL,
        apiKey ?? undefined,
      );
    }
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/providers/${encodeURIComponent(providerName)}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelKey, baseUrl }),
    }),
  );
}

export async function unloadModel(
  providerName: string,
  modelKey: string,
  baseUrl?: string,
): Promise<void> {
  if (useDirectServices()) {
    const svc = await getServices();
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const apiKey = await getSecureSetting(svc.storage, "ai_api_key");
    if (providerName === "lmstudio") {
      const { unloadLMStudioModel } = await import("../../../ai/model-discovery.js");
      await unloadLMStudioModel(
        modelKey,
        baseUrl || baseUrlSetting?.value || DEFAULT_LMSTUDIO_BASE_URL,
        apiKey ?? undefined,
      );
    }
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/providers/${encodeURIComponent(providerName)}/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelKey, baseUrl }),
    }),
  );
}
