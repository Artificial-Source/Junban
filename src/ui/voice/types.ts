/**
 * Browser/cloud voice types, bounds, and local-adapter seams.
 *
 * Local Whisper/Kokoro/Piper adapters are injected later; this wave defines the
 * interfaces only and completes browser/cloud behavior without them.
 */

import type { SpeechProviderPresetDto, VoiceModeDto, VoiceSettingsDto } from "../ai/types";

/** Domain / server audio ceiling (25 MiB). */
export const MAX_SPEECH_AUDIO_BYTES = 25 * 1024 * 1024;

/** Domain AI_USER_INPUT_BYTES_MAX — transcript / synthesis text ceiling. */
export const MAX_SPEECH_TEXT_BYTES = 32 * 1024;

/** Exact multipart field name required by the server. */
export const CLOUD_STT_FIELD_NAME = "audio";

/** Cloud speech routes (OpenAPI). */
export const VOICE_TRANSCRIPTIONS_PATH = "/api/v1/voice/transcriptions";
export const VOICE_SPEECH_PATH = "/api/v1/voice/speech";

/** Server-accepted exact audio MIME tokens (no parameters). */
export const ACCEPTED_AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/mpga",
  "audio/m4a",
  "audio/ogg",
  "audio/flac",
  "audio/webm",
  "audio/opus",
  "audio/aac",
  "audio/pcm",
  "audio/l16",
] as const;

export type AcceptedAudioMime = (typeof ACCEPTED_AUDIO_MIME_TYPES)[number];

/** Cloud TTS response types (canonical). */
export const ACCEPTED_TTS_RESPONSE_MIME = ["audio/mpeg", "audio/wav"] as const;

export type ConfirmedVoiceSettings = Pick<
  VoiceSettingsDto,
  | "cloud_speech_enabled"
  | "grace_period_ms"
  | "stt_provider"
  | "stt_model"
  | "tts_provider"
  | "tts_model"
  | "tts_voice"
  | "tts_enabled"
  | "voice_mode"
  | "stt_credential_id"
  | "tts_credential_id"
>;

export type VoiceMode = VoiceModeDto;
export type SpeechProvider = SpeechProviderPresetDto;

/**
 * Coherent controller phase.
 * Overlay presentation maps thinking → processing for legacy parity.
 */
export type VoicePhase =
  "idle" | "arming" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

/** Legacy overlay call states (visual authority). */
export type VoiceCallPresentationState = "greeting" | "listening" | "processing" | "speaking";

export type VoiceButtonPresentationState =
  "idle" | "listening" | "transcribing" | "speaking" | "error";

export type VoiceErrorCode =
  | "unsupported"
  | "permission_denied"
  | "not_allowed"
  | "no_speech"
  | "audio_capture"
  | "network"
  | "aborted"
  | "empty_audio"
  | "audio_too_large"
  | "unsupported_mime"
  | "cloud_disabled"
  | "invalid_response"
  | "playback_failed"
  | "vad_failed"
  | "unknown";

export type VoiceError = {
  code: VoiceErrorCode;
  /** Safe user-facing message — never raw Error objects, transcripts, or tokens. */
  message: string;
};

/** Monotonic generation fence for async continuations. */
export type VoiceGenerations = {
  /** Surface mount / provider-disable generation. */
  surface: number;
  /** Start/End call generation. */
  call: number;
  /** Per listen/transcribe utterance. */
  utterance: number;
  /** Per AI response synthesis. */
  response: number;
};

export function createVoiceGenerations(): VoiceGenerations {
  return { surface: 0, call: 0, utterance: 0, response: 0 };
}

export type LocalAdapterStatus = "unavailable" | "idle" | "loading" | "ready" | "error";

/**
 * Injected by the AI-route local adapter hook after explicit local preference
 * selection. Controllers must not import Whisper here. Adapter present means
 * local is selected — not ready implies no Browser speech fallback.
 */
export type LocalSttAdapter = {
  readonly status: LocalAdapterStatus;
  transcribe(audio: Blob, options?: { signal?: AbortSignal }): Promise<string>;
  dispose(): void;
};

/**
 * Injected by the AI-route local adapter hook after explicit local preference
 * selection. Controllers must not import Kokoro/Piper here.
 */
export type LocalTtsAdapter = {
  readonly status: LocalAdapterStatus;
  speak(text: string, options?: { signal?: AbortSignal; voice?: string | null }): Promise<void>;
  cancel(): void;
  dispose(): void;
};

/** Explicit fixture view-model for immutable visual scenes 10–14. */
export type VoiceFixture = {
  /** Force VoiceButton presentation without mic/network. */
  buttonState?: VoiceButtonPresentationState;
  buttonPermissionError?: string | null;
  /** Force call overlay without mic/network/VAD/audio. */
  callActive?: boolean;
  callState?: VoiceCallPresentationState;
  callDuration?: number;
  isInGracePeriod?: boolean;
  gracePeriodProgress?: number;
  recognitionError?: string | null;
  /** Hide call button / PTT regardless of settings. */
  hideCallButton?: boolean;
  hidePttButton?: boolean;
};

export const MICROPHONE_PERMISSION_GUIDANCE =
  "Microphone access was denied. Allow microphone access in your browser settings, then retry.";

export const BROWSER_STT_PRIVACY_NOTE =
  "Browser speech recognition may use a browser vendor cloud service and the system default microphone.";
