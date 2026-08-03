/**
 * Voice Settings presentation constants.
 */

import type { AiSecretKindDto, SpeechProviderPresetDto, VoiceModeDto } from "../../../ai/types";

/** Domain grace period bounds (ms). */
export const GRACE_PERIOD_MS_MIN = 500;
export const GRACE_PERIOD_MS_MAX = 3000;
export const GRACE_PERIOD_MS_DEFAULT = 1000;

/** STT providers — Inworld is never offered for speech-to-text. */
export const STT_PROVIDERS: { id: SpeechProviderPresetDto; label: string; cloud: boolean }[] = [
  { id: "browser", label: "Browser", cloud: false },
  { id: "openai", label: "OpenAI", cloud: true },
  { id: "groq", label: "Groq", cloud: true },
];

/** TTS providers — Browser / OpenAI / Groq / Inworld. */
export const TTS_PROVIDERS: { id: SpeechProviderPresetDto; label: string; cloud: boolean }[] = [
  { id: "browser", label: "Browser", cloud: false },
  { id: "openai", label: "OpenAI", cloud: true },
  { id: "groq", label: "Groq", cloud: true },
  { id: "inworld", label: "Inworld", cloud: true },
];

export const VOICE_MODE_OPTIONS: { id: VoiceModeDto; label: string }[] = [
  { id: "push_to_talk", label: "Push-to-Talk" },
  { id: "hands_free", label: "VAD (Hands-free)" },
];

export const BROWSER_SPEECH_WARNING =
  "Browser speech recognition may use a browser vendor cloud service and the system default microphone device unless you select one below after granting permission.";

export const CLOUD_SPEECH_HELP =
  "Cloud speech sends audio to the selected provider through the Junban server. Credentials stay server-side and are never stored in the browser.";

export function speechSecretKind(provider: SpeechProviderPresetDto): AiSecretKindDto {
  if (provider === "inworld") return "inworld_basic";
  return "api_key";
}

export function speechSecretKindOptions(
  provider: SpeechProviderPresetDto,
): { value: AiSecretKindDto; label: string }[] | undefined {
  if (provider === "inworld") {
    return [
      { value: "inworld_basic", label: "Inworld Basic" },
      { value: "inworld_jwt", label: "Inworld JWT" },
    ];
  }
  return undefined;
}

export function speechProviderHelp(provider: SpeechProviderPresetDto): string {
  switch (provider) {
    case "openai":
      return "OpenAI speech. Get your API key at platform.openai.com.";
    case "groq":
      return "Groq Whisper (STT) and PlayAI (TTS). Free tier available at groq.com.";
    case "inworld":
      return "High-quality TTS. Get credentials at platform.inworld.ai.";
    default:
      return "Uses the browser built-in speech APIs on this device.";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortDigest(sha256: string): string {
  if (sha256.length < 16) return sha256;
  return `${sha256.slice(0, 12)}…${sha256.slice(-8)}`;
}
