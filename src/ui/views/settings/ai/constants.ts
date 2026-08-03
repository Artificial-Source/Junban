/**
 * AI Settings presentation constants (copy + bounds mirrored from domain).
 */

import type { AiProviderPresetDto, AiSecretKindDto } from "../../../ai/types";

/** Domain `AI_CUSTOM_INSTRUCTIONS_BYTES_MAX`. */
export const CUSTOM_INSTRUCTIONS_MAX = 16 * 1024;

/** Domain `AI_MEMORY_BYTES_MAX`. */
export const MEMORY_CONTENT_MAX = 10_000;

/** Domain `AI_MEMORIES_PER_PROFILE_MAX`. */
export const MEMORIES_PER_PROFILE_MAX = 500;

/** Domain `AI_MEMORY_PAGE_MAX` — page size for settings memory list. */
export const MEMORY_PAGE_SIZE = 100;

export const ENERGY_OPTIONS: { value: string; label: string; energy: number | null }[] = [
  { value: "", label: "Not set", energy: null },
  { value: "1", label: "1 — Very low", energy: 1 },
  { value: "2", label: "2 — Low", energy: 2 },
  { value: "3", label: "3 — Medium", energy: 3 },
  { value: "4", label: "4 — High", energy: 4 },
  { value: "5", label: "5 — Peak", energy: 5 },
];

export const PROVIDER_HELP: Partial<Record<AiProviderPresetDto, string>> = {
  openai: "Get your API key at platform.openai.com.",
  anthropic: "Get your API key at console.anthropic.com.",
  gemini: "Get your API key at aistudio.google.com.",
  openrouter: "Unified gateway for many models. Get your key at openrouter.ai.",
  ollama: "Free local models. Install at ollama.com — no API key needed.",
  lm_studio: "Local model server. Download at lmstudio.ai — no API key needed.",
  deepseek: "Get your API key at platform.deepseek.com.",
  mistral: "Get your API key at console.mistral.ai.",
  kimi: "Moonshot / Kimi API. Get your key from the Moonshot console.",
  dashscope: "Alibaba Cloud DashScope compatible mode.",
  groq: "Fast inference. Get your key at console.groq.com.",
  z_ai: "Z.AI / GLM API access.",
  custom: "Operator-authored OpenAI-compatible endpoint. HTTPS or loopback HTTP only.",
};

export const ORIGIN_PRIVACY_COPY: Record<string, string> = {
  fixed_cloud_https:
    "This provider sends prompts and context to a cloud HTTPS endpoint. Secrets stay on the Junban server and are never stored in the browser.",
  loopback:
    "This provider targets a loopback local server. Traffic stays on this machine when the endpoint is local.",
  operator_custom:
    "Custom endpoints are operator-authored. Private-network HTTPS is allowed only as an explicit configuration — review the URL before saving.",
};

export function defaultSecretKindForProvider(
  provider: AiProviderPresetDto | null | undefined,
): AiSecretKindDto {
  void provider;
  return "api_key";
}

export function capabilityLabels(capabilities: string[]): string {
  if (capabilities.length === 0) return "No advertised capabilities";
  return capabilities
    .map((cap) =>
      cap
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
    )
    .join(" · ");
}
