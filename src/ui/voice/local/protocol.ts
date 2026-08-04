/**
 * Dependency-free worker protocol for local Whisper / Kokoro / Piper engines.
 *
 * Every request and response carries requestId + caller generation. Only the
 * discriminated message shapes below are valid; unknown messages are rejected.
 * Error payloads use stable redacted codes/messages — never package stacks,
 * model bytes, or user transcript/synthesis text.
 */

/** 16 kHz mono PCM accepted by the Whisper worker. */
export const LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ = 16_000;

/** Maximum PCM byte length for one transcription request (25 MiB). */
export const LOCAL_VOICE_MAX_PCM_BYTES = 25 * 1024 * 1024;

/** Maximum UTF-8 transcript bytes returned from Whisper. */
export const LOCAL_VOICE_MAX_TRANSCRIPT_BYTES = 32 * 1024;

/** Maximum UTF-8 synthesis input bytes for Kokoro/Piper. */
export const LOCAL_VOICE_MAX_SYNTHESIS_TEXT_BYTES = 32 * 1024;

/** Maximum WAV/PCM audio bytes returned from one synthesis. */
export const LOCAL_VOICE_MAX_AUDIO_OUT_BYTES = 25 * 1024 * 1024;

/** Default host timeout for engine load (model construct). */
export const LOCAL_VOICE_LOAD_TIMEOUT_MS = 120_000;

/** Default host timeout for one inference call. */
export const LOCAL_VOICE_INFER_TIMEOUT_MS = 60_000;

/** Default host timeout for dispose acknowledgment (best-effort). */
export const LOCAL_VOICE_DISPOSE_TIMEOUT_MS = 5_000;

export type LocalVoiceErrorCode =
  | "invalid_message"
  | "not_loaded"
  | "already_loaded"
  | "invalid_audio"
  | "invalid_text"
  | "infer_failed"
  | "load_failed"
  | "disposed"
  | "timeout"
  | "aborted"
  | "busy"
  | "cache_miss"
  | "unsupported"
  | "worker_error";

/** Stable operator-facing messages; never include user or model content. */
export const LOCAL_VOICE_ERROR_MESSAGES: Readonly<Record<LocalVoiceErrorCode, string>> = {
  invalid_message: "Invalid local voice worker message",
  not_loaded: "Local voice engine is not loaded",
  already_loaded: "Local voice engine is already loaded",
  invalid_audio: "Invalid or out-of-bounds audio input",
  invalid_text: "Invalid or out-of-bounds synthesis text",
  infer_failed: "Local voice inference failed",
  load_failed: "Local voice engine failed to load",
  disposed: "Local voice engine is disposed",
  timeout: "Local voice operation timed out",
  aborted: "Local voice operation aborted",
  busy: "Local voice engine is busy",
  cache_miss: "Verified local voice model cache is missing",
  unsupported: "Unsupported local voice operation",
  worker_error: "Local voice worker failed",
};

export type LocalVoiceEngineKind = "whisper" | "kokoro" | "piper";

export type LocalVoiceRequest =
  | { readonly type: "ping"; readonly requestId: string; readonly generation: number }
  | { readonly type: "load"; readonly requestId: string; readonly generation: number }
  | {
      readonly type: "transcribe";
      readonly requestId: string;
      readonly generation: number;
      /** Transferable Float32 PCM bytes (mono, 16 kHz). */
      readonly pcm: ArrayBuffer;
      readonly sampleRate: number;
    }
  | {
      readonly type: "synthesize";
      readonly requestId: string;
      readonly generation: number;
      readonly text: string;
    }
  | { readonly type: "dispose"; readonly requestId: string; readonly generation: number };

export type LocalVoiceAudioFormat = "pcm-f32" | "wav";

export type LocalVoiceResponse =
  | { readonly type: "pong"; readonly requestId: string; readonly generation: number }
  | {
      readonly type: "load-complete";
      readonly requestId: string;
      readonly generation: number;
      readonly packageId: string;
      readonly modelId: string;
      readonly revision: string;
      readonly voiceId?: string;
    }
  | {
      readonly type: "transcript";
      readonly requestId: string;
      readonly generation: number;
      readonly text: string;
    }
  | {
      readonly type: "audio";
      readonly requestId: string;
      readonly generation: number;
      readonly format: LocalVoiceAudioFormat;
      readonly sampleRate: number;
      readonly channels: number;
      /** Transferable PCM float32 bytes when format is pcm-f32. */
      readonly pcm?: ArrayBuffer;
      /** Transferable WAV bytes when format is wav. */
      readonly wav?: ArrayBuffer;
    }
  | { readonly type: "disposed"; readonly requestId: string; readonly generation: number }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly generation: number;
      readonly code: LocalVoiceErrorCode;
      readonly message: string;
    };

export type LocalVoiceRequestType = LocalVoiceRequest["type"];
export type LocalVoiceResponseType = LocalVoiceResponse["type"];

const REQUEST_TYPES = new Set<string>(["ping", "load", "transcribe", "synthesize", "dispose"]);
const RESPONSE_TYPES = new Set<string>([
  "pong",
  "load-complete",
  "transcript",
  "audio",
  "disposed",
  "error",
]);

export function isLocalVoiceRequest(value: unknown): value is LocalVoiceRequest {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  if (typeof msg.type !== "string" || !REQUEST_TYPES.has(msg.type)) return false;
  if (typeof msg.requestId !== "string" || msg.requestId.length === 0) return false;
  if (typeof msg.generation !== "number" || !Number.isFinite(msg.generation)) return false;
  switch (msg.type) {
    case "ping":
    case "load":
    case "dispose":
      return true;
    case "transcribe":
      return msg.pcm instanceof ArrayBuffer && typeof msg.sampleRate === "number";
    case "synthesize":
      return typeof msg.text === "string";
    default:
      return false;
  }
}

export function isLocalVoiceResponse(value: unknown): value is LocalVoiceResponse {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  if (typeof msg.type !== "string" || !RESPONSE_TYPES.has(msg.type)) return false;
  if (typeof msg.requestId !== "string" || msg.requestId.length === 0) return false;
  if (typeof msg.generation !== "number" || !Number.isFinite(msg.generation)) return false;
  if (msg.type === "error") {
    return typeof msg.code === "string" && typeof msg.message === "string";
  }
  return true;
}

export function localVoiceError(
  code: LocalVoiceErrorCode,
  requestId: string,
  generation: number,
): Extract<LocalVoiceResponse, { type: "error" }> {
  return {
    type: "error",
    requestId,
    generation,
    code,
    message: LOCAL_VOICE_ERROR_MESSAGES[code],
  };
}

/** Validate mono Float32 PCM for Whisper: finite samples, 16 kHz, within byte bound. */
export function validateWhisperPcm(
  pcm: ArrayBuffer,
  sampleRate: number,
): { ok: true; samples: Float32Array } | { ok: false; code: LocalVoiceErrorCode } {
  if (sampleRate !== LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ) {
    return { ok: false, code: "invalid_audio" };
  }
  if (pcm.byteLength === 0 || pcm.byteLength > LOCAL_VOICE_MAX_PCM_BYTES) {
    return { ok: false, code: "invalid_audio" };
  }
  if (pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return { ok: false, code: "invalid_audio" };
  }
  const samples = new Float32Array(pcm);
  if (samples.length === 0) {
    return { ok: false, code: "invalid_audio" };
  }
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]!;
    if (!Number.isFinite(value)) {
      return { ok: false, code: "invalid_audio" };
    }
  }
  return { ok: true, samples };
}

/** Validate synthesis text: nonempty, within byte bound, no disallowed controls. */
export function validateSynthesisText(
  text: string,
): { ok: true; text: string } | { ok: false; code: LocalVoiceErrorCode } {
  if (typeof text !== "string") {
    return { ok: false, code: "invalid_text" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "invalid_text" };
  }
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength > LOCAL_VOICE_MAX_SYNTHESIS_TEXT_BYTES) {
    return { ok: false, code: "invalid_text" };
  }
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    // Allow TAB/LF/CR; reject other C0 controls and DEL.
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return { ok: false, code: "invalid_text" };
    }
  }
  return { ok: true, text: trimmed };
}

/** Bound a transcript for the wire; empty after trim is invalid. */
export function boundTranscript(
  text: string,
): { ok: true; text: string } | { ok: false; code: LocalVoiceErrorCode } {
  if (typeof text !== "string") {
    return { ok: false, code: "infer_failed" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "infer_failed" };
  }
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength > LOCAL_VOICE_MAX_TRANSCRIPT_BYTES) {
    return { ok: false, code: "infer_failed" };
  }
  return { ok: true, text: trimmed };
}

/** Validate finite PCM output from Kokoro. */
export function validatePcmAudioOut(
  pcm: Float32Array,
  sampleRate: number,
  channels: number,
): { ok: true; buffer: ArrayBuffer } | { ok: false; code: LocalVoiceErrorCode } {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 96_000) {
    return { ok: false, code: "infer_failed" };
  }
  if (channels !== 1) {
    return { ok: false, code: "infer_failed" };
  }
  if (!(pcm instanceof Float32Array) || pcm.length === 0) {
    return { ok: false, code: "infer_failed" };
  }
  if (pcm.byteLength > LOCAL_VOICE_MAX_AUDIO_OUT_BYTES) {
    return { ok: false, code: "infer_failed" };
  }
  for (let i = 0; i < pcm.length; i += 1) {
    if (!Number.isFinite(pcm[i]!)) {
      return { ok: false, code: "infer_failed" };
    }
  }
  // Copy into a fresh ArrayBuffer so the transfer list detaches only the wire copy.
  const copy = new Float32Array(pcm.length);
  copy.set(pcm);
  return { ok: true, buffer: copy.buffer };
}

/** Validate nonempty WAV bytes from Piper. */
export function validateWavAudioOut(
  bytes: ArrayBuffer,
): { ok: true; buffer: ArrayBuffer } | { ok: false; code: LocalVoiceErrorCode } {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 44) {
    return { ok: false, code: "infer_failed" };
  }
  if (bytes.byteLength > LOCAL_VOICE_MAX_AUDIO_OUT_BYTES) {
    return { ok: false, code: "infer_failed" };
  }
  const view = new Uint8Array(bytes);
  // RIFF....WAVE
  if (
    view[0] !== 0x52 ||
    view[1] !== 0x49 ||
    view[2] !== 0x46 ||
    view[3] !== 0x46 ||
    view[8] !== 0x57 ||
    view[9] !== 0x41 ||
    view[10] !== 0x56 ||
    view[11] !== 0x45
  ) {
    return { ok: false, code: "infer_failed" };
  }
  const copy = bytes.slice(0);
  return { ok: true, buffer: copy };
}

export class LocalVoiceClientError extends Error {
  readonly code: LocalVoiceErrorCode;

  constructor(code: LocalVoiceErrorCode, message?: string) {
    super(message ?? LOCAL_VOICE_ERROR_MESSAGES[code]);
    this.name = "LocalVoiceClientError";
    this.code = code;
  }
}
