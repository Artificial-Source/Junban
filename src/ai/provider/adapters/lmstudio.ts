/**
 * LM Studio provider — OpenAI-compatible with native API discovery + model loading.
 * Supports optional API key auth for hosted/remote LM Studio servers.
 */

import { createOpenAICompatPlugin } from "./openai-compat.js";
import type { LLMProviderPlugin } from "../interface.js";
import type { ModelDescriptor } from "../../core/capabilities.js";
import type { AIProviderConfig } from "../../types.js";
import { DEFAULT_CAPABILITIES } from "../../core/capabilities.js";

const FETCH_TIMEOUT_MS = 5000;
const LOAD_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function getLMStudioHost(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/** Build auth headers when an API key is provided. */
function authHeaders(apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

/** LM Studio native API response shape (v0.4.0+) */
interface LMStudioModel {
  type: string;
  key: string;
  display_name: string;
  publisher: string;
  architecture?: string;
  params_string?: string;
  loaded_instances: { id: string }[];
}

async function discoverLMStudioModels(config: AIProviderConfig): Promise<ModelDescriptor[]> {
  const baseUrl = config.baseUrl ?? "http://localhost:1234/v1";
  const host = getLMStudioHost(baseUrl);
  const auth = authHeaders(config.apiKey);

  // Try LM Studio native API first (v0.4.0+)
  try {
    const res = await fetchWithTimeout(`${host}/api/v1/models`, {
      headers: { ...auth },
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: LMStudioModel[] };
      if (data.models && data.models.length > 0) {
        return data.models
          .filter((m) => m.type === "llm")
          .map((m) => ({
            id: m.key,
            label: `${m.display_name}${m.params_string ? ` (${m.params_string})` : ""}`,
            capabilities: { ...DEFAULT_CAPABILITIES },
            loaded: m.loaded_instances.length > 0,
          }));
      }
    }
  } catch {
    // Fall through to OpenAI-compatible endpoint
  }

  // Fallback: OpenAI-compatible /v1/models (only loaded models)
  const res = await fetchWithTimeout(`${host}/v1/models`, {
    headers: { ...auth },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => ({
    id: m.id,
    label: m.id,
    capabilities: { ...DEFAULT_CAPABILITIES },
    loaded: true,
  }));
}

async function loadLMStudioModel(modelKey: string, config: AIProviderConfig): Promise<void> {
  const baseUrl = config.baseUrl ?? "http://localhost:1234/v1";
  const host = getLMStudioHost(baseUrl);
  const auth = authHeaders(config.apiKey);
  const res = await fetchWithTimeout(
    `${host}/api/v1/models/load`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model: modelKey }),
    },
    LOAD_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to load model: ${text || res.statusText}`);
  }
}

/** Unload a model from LM Studio (POST /api/v1/models/unload). */
export async function unloadLMStudioModel(
  modelKey: string,
  config: AIProviderConfig,
): Promise<void> {
  const baseUrl = config.baseUrl ?? "http://localhost:1234/v1";
  const host = getLMStudioHost(baseUrl);
  const auth = authHeaders(config.apiKey);
  const res = await fetchWithTimeout(`${host}/api/v1/models/unload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ model: modelKey }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to unload model: ${text || res.statusText}`);
  }
}

export const lmstudioPlugin: LLMProviderPlugin = createOpenAICompatPlugin({
  name: "lmstudio",
  displayName: "LM Studio",
  needsApiKey: false,
  optionalApiKey: true,
  defaultModel: "default",
  defaultBaseUrl: "http://localhost:1234/v1",
  showBaseUrl: true,
  fakeApiKey: "lm-studio",
  discoverModels: discoverLMStudioModels,
  loadModel: loadLMStudioModel,
  unloadModel: unloadLMStudioModel,
});
