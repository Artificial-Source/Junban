/**
 * Stable browser speech error taxonomy (no raw event objects in diagnostics).
 */

import type { VoiceError, VoiceErrorCode } from "./types";
import { MICROPHONE_PERMISSION_GUIDANCE } from "./types";

const SAFE_MESSAGES: Record<VoiceErrorCode, string> = {
  unsupported: "Speech is not supported in this browser.",
  permission_denied: MICROPHONE_PERMISSION_GUIDANCE,
  not_allowed: MICROPHONE_PERMISSION_GUIDANCE,
  no_speech: "No speech was detected. Try again.",
  audio_capture: "Could not capture audio from the microphone.",
  network: "A network error interrupted speech. Try again.",
  aborted: "Speech was cancelled.",
  empty_audio: "Recorded audio was empty.",
  audio_too_large: "Recorded audio exceeds the 25 MiB limit.",
  unsupported_mime: "This browser recorded an unsupported audio format.",
  cloud_disabled: "Cloud speech is not enabled in Settings.",
  invalid_response: "The speech service returned an invalid response.",
  playback_failed: "Could not play synthesized speech.",
  vad_failed: "Voice activity detection failed to start.",
  unknown: "Speech failed. Try again.",
};

export function voiceError(code: VoiceErrorCode, message?: string): VoiceError {
  return {
    code,
    message: message && message.trim() ? scrubDiagnostic(message) : SAFE_MESSAGES[code],
  };
}

/** Map Web Speech API error codes to the stable taxonomy. */
export function mapSpeechRecognitionError(errorCode: string): VoiceError {
  switch (errorCode) {
    case "not-allowed":
    case "service-not-allowed":
      return voiceError("permission_denied");
    case "no-speech":
      return voiceError("no_speech");
    case "audio-capture":
      return voiceError("audio_capture");
    case "network":
      return voiceError("network");
    case "aborted":
      return voiceError("aborted");
    default:
      return voiceError("unknown");
  }
}

export function isPermissionVoiceError(error: VoiceError | null | undefined): boolean {
  return error?.code === "permission_denied" || error?.code === "not_allowed";
}

export function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return name === "AbortError" || code === "aborted" || code === "ABORT_ERR";
}

export function mapDomException(error: unknown): VoiceError {
  if (isAbortLike(error)) return voiceError("aborted");
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return voiceError("permission_denied");
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return voiceError("audio_capture");
  }
  if (name === "NotSupportedError") {
    return voiceError("unsupported");
  }
  return voiceError("unknown");
}

/** Strip tokens/transcripts from accidental diagnostic strings. */
export function scrubDiagnostic(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .slice(0, 280);
}

export function isSpeechRecognitionPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error) {
    const code = String((error as { code?: unknown }).code);
    return code === "not-allowed" || code === "service-not-allowed" || code === "permission_denied";
  }
  return false;
}
