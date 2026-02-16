/**
 * Dynamic model discovery for AI providers.
 * Fetches available models from provider APIs with graceful fallbacks.
 */

const FETCH_TIMEOUT_MS = 5000;
const LOAD_TIMEOUT_MS = 120_000; // Model loading can take a while

const ANTHROPIC_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
];

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const res = await fetchWithTimeout(`${baseUrl}/api/tags`);
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
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

export interface ModelInfo {
  id: string;
  label: string;
  loaded: boolean;
}

function getLMStudioHost(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

async function fetchLMStudioModels(baseUrl: string): Promise<ModelInfo[]> {
  const host = getLMStudioHost(baseUrl);

  // Try LM Studio native API (v0.4.0+): GET /api/v1/models
  // Returns ALL downloaded models with loaded_instances showing which are active
  try {
    const res = await fetchWithTimeout(`${host}/api/v1/models`);
    if (res.ok) {
      const data = (await res.json()) as { models?: LMStudioModel[] };
      if (data.models && data.models.length > 0) {
        return data.models
          .filter((m) => m.type === "llm")
          .map((m) => ({
            id: m.key,
            label: `${m.display_name}${m.params_string ? ` (${m.params_string})` : ""}`,
            loaded: m.loaded_instances.length > 0,
          }));
      }
    }
  } catch {
    // Fall through to OpenAI-compatible endpoint
  }

  // Fall back to OpenAI-compatible endpoint: GET /v1/models (only loaded models)
  const res = await fetchWithTimeout(`${host}/v1/models`);
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => ({ id: m.id, label: m.id, loaded: true }));
}

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: { id: string }[] };
  const models = (data.data ?? []).map((m) => m.id);
  return models.filter((id) => /gpt|o[1-9]|chatgpt/.test(id)).sort();
}

async function fetchOpenRouterModels(apiKey: string): Promise<string[]> {
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

export async function fetchAvailableModels(
  providerName: string,
  config: { apiKey?: string; baseUrl?: string },
): Promise<ModelInfo[]> {
  try {
    switch (providerName) {
      case "ollama": {
        const names = await fetchOllamaModels(config.baseUrl ?? "http://localhost:11434");
        return names.map((n) => ({ id: n, label: n, loaded: true }));
      }
      case "lmstudio":
        return await fetchLMStudioModels(config.baseUrl ?? "http://localhost:1234/v1");
      case "openai": {
        if (!config.apiKey) return [];
        const names = await fetchOpenAIModels(config.apiKey);
        return names.map((n) => ({ id: n, label: n, loaded: true }));
      }
      case "openrouter": {
        if (!config.apiKey) return [];
        const names = await fetchOpenRouterModels(config.apiKey);
        return names.map((n) => ({ id: n, label: n, loaded: true }));
      }
      case "anthropic":
        return ANTHROPIC_MODELS.map((n) => ({ id: n, label: n, loaded: true }));
      default:
        return [];
    }
  } catch {
    return [];
  }
}

/**
 * Load a model in LM Studio via native API.
 * Returns the instance ID on success, or throws on failure.
 */
export async function loadLMStudioModel(
  modelKey: string,
  baseUrl: string,
): Promise<string> {
  const host = getLMStudioHost(baseUrl);
  const res = await fetchWithTimeout(
    `${host}/api/v1/models/load`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelKey }),
    },
    LOAD_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to load model: ${text || res.statusText}`);
  }
  const data = (await res.json()) as { instance_id?: string; status?: string };
  return data.instance_id ?? modelKey;
}
