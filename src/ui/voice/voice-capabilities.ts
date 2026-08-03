/**
 * Pure helpers for confirmed voice capability and presentation mapping.
 */

import { isBrowserSttAvailable } from "./browser-stt";
import { isBrowserTtsAvailable } from "./browser-tts";
import type {
  ConfirmedVoiceSettings,
  LocalSttAdapter,
  LocalTtsAdapter,
  VoiceButtonPresentationState,
  VoiceCallPresentationState,
  VoiceError,
  VoicePhase,
} from "./types";
import { isPermissionVoiceError } from "./speech-errors";

export function isCloudStt(settings: ConfirmedVoiceSettings): boolean {
  return (
    settings.cloud_speech_enabled &&
    (settings.stt_provider === "openai" || settings.stt_provider === "groq")
  );
}

export function isCloudTts(settings: ConfirmedVoiceSettings): boolean {
  return (
    settings.cloud_speech_enabled &&
    settings.tts_enabled &&
    (settings.tts_provider === "openai" ||
      settings.tts_provider === "groq" ||
      settings.tts_provider === "inworld")
  );
}

/**
 * Local adapter present means the user explicitly selected a local package.
 * Presence alone is not readiness — and must not fall back to Browser speech.
 */
export function isLocalSttSelected(localStt: LocalSttAdapter | null | undefined): boolean {
  return localStt != null;
}

export function isLocalTtsSelected(localTts: LocalTtsAdapter | null | undefined): boolean {
  return localTts != null;
}

export function resolveTtsAvailable(
  settings: ConfirmedVoiceSettings,
  localTts: LocalTtsAdapter | null | undefined,
  fixture: boolean,
): boolean {
  if (!settings.tts_enabled) return false;
  // Cloud confirmed never consults local adapters (hook passes null).
  if (isCloudTts(settings)) return true;
  // Explicit local selection: available only when ready — never Browser fallback.
  if (isLocalTtsSelected(localTts)) {
    return localTts!.status === "ready";
  }
  if (settings.tts_provider === "browser") {
    return fixture ? true : isBrowserTtsAvailable();
  }
  return false;
}

export function resolveSttReady(
  settings: ConfirmedVoiceSettings,
  localStt: LocalSttAdapter | null | undefined,
  fixture: boolean,
): boolean {
  if (isCloudStt(settings)) return true;
  // Explicit local selection: ready only when adapter is ready — never Browser.
  if (isLocalSttSelected(localStt)) {
    return localStt!.status === "ready";
  }
  if (settings.stt_provider === "browser") {
    return fixture ? true : isBrowserSttAvailable();
  }
  return false;
}

export function phaseToCallState(phase: VoicePhase): VoiceCallPresentationState | "idle" {
  switch (phase) {
    case "arming":
      return "greeting";
    case "listening":
      return "listening";
    case "transcribing":
    case "thinking":
      return "processing";
    case "speaking":
      return "speaking";
    case "error":
      return "listening";
    default:
      return "idle";
  }
}

export function phaseToButtonState(
  phase: VoicePhase,
  error: VoiceError | null,
): VoiceButtonPresentationState {
  if (error && isPermissionVoiceError(error)) return "error";
  switch (phase) {
    case "listening":
    case "arming":
      return "listening";
    case "transcribing":
      return "transcribing";
    case "speaking":
      return "speaking";
    case "thinking":
      return "transcribing";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

export function settingsIdentityKey(settings: ConfirmedVoiceSettings): string {
  return `${settings.stt_provider}|${settings.tts_provider}|${settings.voice_mode}|${settings.cloud_speech_enabled}|${settings.tts_enabled}`;
}
