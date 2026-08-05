/**
 * Audio helpers: WAV encode, MediaRecorder MIME selection, MIME normalization.
 */

import { ACCEPTED_AUDIO_MIME_TYPES, MAX_SPEECH_AUDIO_BYTES, type AcceptedAudioMime } from "./types";
import { voiceError } from "./speech-errors";
import type { VoiceError } from "./types";

const RECORDER_MIME_CANDIDATES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"] as const;

const ACCEPTED_SET = new Set<string>(ACCEPTED_AUDIO_MIME_TYPES);

/** Strip parameters (codecs=…) and lowercase. */
export function stripMimeParameters(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Map a MIME token to a server-accepted exact type, or null. */
export function normalizeAcceptedAudioMime(mime: string): AcceptedAudioMime | null {
  const base = stripMimeParameters(mime);
  if (!base) return null;
  if (ACCEPTED_SET.has(base)) return base as AcceptedAudioMime;
  return null;
}

/** Prefer a supported MediaRecorder MIME without parameters. */
export function selectMediaRecorderMime(
  isTypeSupported: (mime: string) => boolean = (mime) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime),
): string | null {
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (isTypeSupported(candidate)) return candidate;
  }
  // No known candidate — empty string means browser default when MediaRecorder exists.
  if (typeof MediaRecorder === "undefined") return null;
  return "";
}

export function filenameForAudioMime(mime: AcceptedAudioMime): string {
  switch (mime) {
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "audio.wav";
    case "audio/mp3":
    case "audio/mpeg":
    case "audio/mpga":
      return "audio.mp3";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "audio.m4a";
    case "audio/ogg":
    case "audio/opus":
      return "audio.ogg";
    case "audio/flac":
      return "audio.flac";
    case "audio/webm":
      return "audio.webm";
    case "audio/aac":
      return "audio.aac";
    case "audio/pcm":
    case "audio/l16":
      return "audio.pcm";
    default:
      return "audio.bin";
  }
}

export type ValidatedAudioBlob = {
  blob: Blob;
  mime: AcceptedAudioMime;
  byteLength: number;
};

/**
 * Reject empty, oversized, or unsupported audio before any network call.
 * Re-wraps the blob with an exact MIME (no parameters).
 */
export function validateAudioBlob(input: Blob): ValidatedAudioBlob | VoiceError {
  const byteLength = input.size;
  if (byteLength <= 0) return voiceError("empty_audio");
  if (byteLength > MAX_SPEECH_AUDIO_BYTES) return voiceError("audio_too_large");
  const mime = normalizeAcceptedAudioMime(input.type || "");
  if (!mime) return voiceError("unsupported_mime");
  const blob = input.type === mime ? input : new Blob([input], { type: mime });
  return { blob, mime, byteLength };
}

/** Convert 16 kHz mono Float32 PCM (−1…1) to a canonical WAV Blob. */
export function float32ToWav(samples: Float32Array, sampleRate = 16_000): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = headerSize;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, val, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Bound concatenated Float32 chunks before WAV encode. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

/**
 * Estimate PCM byte size after int16 conversion and reject before encode when
 * the WAV would exceed the cloud ceiling (header + samples*2).
 */
export function pcmExceedsAudioCeiling(sampleCount: number): boolean {
  return 44 + sampleCount * 2 > MAX_SPEECH_AUDIO_BYTES;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
