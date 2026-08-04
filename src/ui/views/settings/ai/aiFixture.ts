/**
 * Presentation-only AI Settings fixtures for immutable visual baselines.
 * Never touches network, credentials, or production confirmed state.
 */

import type {
  AiConfigResponse,
  AiCredentialBindingsDto,
  AiProviderRegistryEntry,
  AiSettingsDto,
  VoiceSettingsDto,
} from "../../../ai/types";
import { isVisualFixture } from "../../../lib/visualFixture";

export type AiSettingsVisualState = "configured" | "unconfigured";

/** Read explicit phase-6 AI settings fixture state from the URL query. */
export function readAiSettingsVisualState(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): AiSettingsVisualState | null {
  if (!isVisualFixture(search, "phase-6")) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const value = params.get("settings-ai");
  if (value === "configured" || value === "unconfigured") return value;
  return null;
}

function emptyCredentials(): AiCredentialBindingsDto {
  return {
    ai_provider: null,
    voice_stt: null,
    voice_tts: null,
  };
}

function defaultVoice(): VoiceSettingsDto {
  return {
    cloud_speech_enabled: false,
    grace_period_ms: 1000,
    stt_provider: "browser",
    stt_model: null,
    stt_credential_id: null,
    tts_provider: "browser",
    tts_model: null,
    tts_voice: null,
    tts_credential_id: null,
    tts_enabled: true,
    voice_mode: "push_to_talk",
  };
}

/** Fixture config snapshots — no secret-looking values. */
export function fixtureAiConfig(state: AiSettingsVisualState): AiConfigResponse {
  if (state === "unconfigured") {
    const ai: AiSettingsDto = {
      enabled: false,
      provider: null,
      model: null,
      base_url: null,
      credential_id: null,
      custom_instructions: "",
      daily_briefing_enabled: false,
      default_energy: null,
      auto_send: false,
      smart_endpoint: false,
    };
    return { ai, voice: defaultVoice(), credentials: emptyCredentials() };
  }

  const ai: AiSettingsDto = {
    enabled: true,
    provider: "openai",
    model: "gpt-4.1",
    base_url: "https://api.openai.com/v1",
    credential_id: "00000000-0000-4000-8000-000000000001",
    custom_instructions: "",
    daily_briefing_enabled: true,
    default_energy: 3,
    auto_send: false,
    smart_endpoint: false,
  };
  return {
    ai,
    voice: defaultVoice(),
    credentials: {
      ...emptyCredentials(),
      ai_provider: {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "api_key",
        present: true,
        updated_at: "2026-08-02T15:00:00.000Z",
      },
    },
  };
}

/** Static registry used only by the visual fixture path. */
export function fixtureAiProviders(): AiProviderRegistryEntry[] {
  return [
    {
      id: "openai",
      display_name: "OpenAI",
      default_base_url: "https://api.openai.com/v1",
      origin_class: "fixed_cloud_https",
      auth_scheme: "bearer",
      credential_required: true,
      capabilities: ["chat_streaming", "chat_completion", "tools", "model_discovery"],
    },
    {
      id: "ollama",
      display_name: "Ollama",
      default_base_url: "http://127.0.0.1:11434/v1",
      origin_class: "loopback",
      auth_scheme: "none",
      credential_required: false,
      capabilities: ["chat_streaming", "chat_completion", "tools", "model_discovery"],
    },
    {
      id: "custom",
      display_name: "Custom",
      default_base_url: null,
      origin_class: "operator_custom",
      auth_scheme: "bearer",
      credential_required: true,
      capabilities: ["chat_streaming", "chat_completion", "tools", "model_discovery"],
    },
  ];
}
