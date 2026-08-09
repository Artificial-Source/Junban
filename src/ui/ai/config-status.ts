/**
 * Pure helpers for confirmed AI configuration readiness.
 */

import type { AiConfigResponse, AiProviderPresetDto } from "./types";

/** Providers that may run without a stored credential (loopback defaults). */
const CREDENTIAL_OPTIONAL: ReadonlySet<AiProviderPresetDto> = new Set(["ollama", "lm_studio"]);

/**
 * True when the confirmed server snapshot is ready for chat.
 * Matches fail-closed server gates: enabled + provider + model, and a
 * credential when the provider requires one.
 */
export function isAiConfigured(config: AiConfigResponse | null | undefined): boolean {
  if (!config) return false;
  const { ai, credentials } = config;
  if (!ai.enabled) return false;
  if (!ai.provider || !ai.model) return false;
  if (CREDENTIAL_OPTIONAL.has(ai.provider)) return true;
  return Boolean(ai.credential_id) || Boolean(credentials.ai_provider?.present);
}
