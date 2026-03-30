/**
 * OpenRouter provider — thin config over the OpenAI-compatible base.
 *
 * Dynamically discovers models from OpenRouter's API, filters to only
 * those with tool-calling support, and sorts by price (capability proxy)
 * so the best options appear first in the dropdown.
 */

import { createOpenAICompatPlugin } from "./openai-compat.js";
import type { LLMProviderPlugin } from "../interface.js";
import type { ModelDescriptor } from "../../core/capabilities.js";
import type { AIProviderConfig } from "../../types.js";
import { DEFAULT_CAPABILITIES } from "../../core/capabilities.js";
import { fetchWithTimeout } from "./fetch-utils.js";

/** Shape of each model entry from OpenRouter's /models endpoint. */
interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  supported_parameters?: string[];
}

/**
 * Fetch models from OpenRouter, filter to tool-capable only,
 * and sort by prompt price descending (higher price ≈ more capable).
 */
async function discoverOpenRouterModels(config: AIProviderConfig): Promise<ModelDescriptor[]> {
  const apiKey = config.authType === "oauth" ? (config.oauthToken ?? "") : (config.apiKey ?? "");
  if (!apiKey) return [];

  const baseUrl = config.baseUrl ?? "https://openrouter.ai/api/v1";

  try {
    const res = await fetchWithTimeout(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as { data?: OpenRouterModel[] };
    const models = data.data ?? [];

    return models
      .filter(
        (m) =>
          m.supported_parameters != null &&
          m.supported_parameters.includes("tools") &&
          !m.id.includes(":free") &&
          !m.id.includes(":extended"),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({
        id: m.id,
        label: m.name,
        capabilities: { ...DEFAULT_CAPABILITIES },
        loaded: true,
      }));
  } catch {
    return [];
  }
}

export const openrouterPlugin: LLMProviderPlugin = createOpenAICompatPlugin({
  name: "openrouter",
  displayName: "OpenRouter",
  needsApiKey: true,
  defaultModel: "anthropic/claude-sonnet-4.5",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/ASF-GROUP/Junban",
    "X-Title": "ASF Junban",
  },
  discoverModels: discoverOpenRouterModels,
});
