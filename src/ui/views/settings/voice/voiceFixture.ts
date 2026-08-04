/**
 * Presentation-only Voice Settings fixtures for immutable visual baselines.
 * Never touches network, credentials, microphone hardware, or production state.
 */

import type { AiConfigResponse, VoiceSettingsDto } from "../../../ai/types";
import { isVisualFixture } from "../../../lib/visualFixture";
import { fixtureAiConfig } from "../ai/aiFixture";

export type VoiceSettingsVisualState = "browser" | "cloud";

/** Read explicit phase-6 Voice settings fixture state from the URL query. */
export function readVoiceSettingsVisualState(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): VoiceSettingsVisualState | null {
  if (!isVisualFixture(search, "phase-6")) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const value = params.get("settings-voice");
  if (value === "browser" || value === "cloud") return value;
  return null;
}

function browserVoice(): VoiceSettingsDto {
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

function cloudVoice(): VoiceSettingsDto {
  return {
    cloud_speech_enabled: true,
    grace_period_ms: 1200,
    stt_provider: "groq",
    stt_model: "whisper-large-v3",
    stt_credential_id: "00000000-0000-4000-8000-000000000011",
    tts_provider: "openai",
    tts_model: "tts-1",
    tts_voice: "alloy",
    tts_credential_id: "00000000-0000-4000-8000-000000000012",
    tts_enabled: true,
    voice_mode: "hands_free",
  };
}

/** Fixture AI config with the requested voice presentation state. */
export function fixtureVoiceConfig(state: VoiceSettingsVisualState): AiConfigResponse {
  const base = fixtureAiConfig("unconfigured");
  if (state === "browser") {
    return { ...base, voice: browserVoice() };
  }
  return {
    ...base,
    voice: cloudVoice(),
    credentials: {
      ai_provider: null,
      voice_stt: {
        id: "00000000-0000-4000-8000-000000000011",
        kind: "api_key",
        present: true,
        updated_at: "2026-08-02T15:00:00.000Z",
      },
      voice_tts: {
        id: "00000000-0000-4000-8000-000000000012",
        kind: "api_key",
        present: true,
        updated_at: "2026-08-02T15:00:00.000Z",
      },
    },
  };
}
