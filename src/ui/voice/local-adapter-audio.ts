/**
 * Audio conversion helpers for local STT adapters (WAV/PCM decode + resample).
 *
 * No workers, engine packages, network, or playback.
 */

import { normalizeAcceptedAudioMime } from "./audio-utils";
import { voiceError } from "./speech-errors";
import { MAX_SPEECH_AUDIO_BYTES, type VoiceError } from "./types";

export const LOCAL_STT_TARGET_SAMPLE_RATE_HZ = 16_000;

/** Bound decoded PCM sample count (~25 MiB int16 WAV equivalent). */
export const LOCAL_STT_MAX_PCM_SAMPLES = Math.floor((MAX_SPEECH_AUDIO_BYTES - 44) / 2);

export type DecodedMonoPcm = {
  samples: Float32Array;
  sampleRate: number;
};

function isFiniteSample(value: number): boolean {
  return Number.isFinite(value);
}

/** Downmix interleaved PCM to mono by averaging channels. */
export function downmixToMono(input: Float32Array, channels: number): Float32Array {
  const ch = Math.max(1, Math.floor(channels));
  if (ch === 1) {
    const copy = new Float32Array(input.length);
    copy.set(input);
    return copy;
  }
  const frames = Math.floor(input.length / ch);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < ch; c += 1) {
      sum += input[i * ch + c] ?? 0;
    }
    out[i] = sum / ch;
  }
  return out;
}

/** Linear resample mono PCM to a target rate. */
export function resampleMono(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
    return new Float32Array(0);
  }
  if (!Number.isFinite(targetRate) || targetRate <= 0) {
    return new Float32Array(0);
  }
  if (sourceRate === targetRate) {
    const copy = new Float32Array(input.length);
    copy.set(input);
    return copy;
  }
  if (input.length === 0) return new Float32Array(0);

  const ratio = sourceRate / targetRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    const s0 = input[i0] ?? 0;
    const s1 = input[i1] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

/** Reject non-finite samples and enforce the PCM sample ceiling. */
export function sanitizePcm(samples: Float32Array): Float32Array | VoiceError {
  if (samples.length <= 0) return voiceError("empty_audio");
  if (samples.length > LOCAL_STT_MAX_PCM_SAMPLES) return voiceError("audio_too_large");
  for (let i = 0; i < samples.length; i += 1) {
    if (!isFiniteSample(samples[i]!)) return voiceError("invalid_response");
  }
  return samples;
}

/**
 * Parse canonical little-endian PCM WAV (16-bit or float32) into mono float PCM.
 * Returns null when the container is not a simple WAV the adapter can handle
 * without decodeAudioData.
 */
export function tryParseWavPcm(buffer: ArrayBuffer): DecodedMonoPcm | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  const riff =
    String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) ===
    "RIFF";
  const wave =
    String.fromCharCode(
      view.getUint8(8),
      view.getUint8(9),
      view.getUint8(10),
      view.getUint8(11),
    ) === "WAVE";
  if (!riff || !wave) return null;

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = size;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || channels < 1 || sampleRate <= 0) return null;
  if (audioFormat !== 1 && audioFormat !== 3) return null;
  if (audioFormat === 1 && bitsPerSample !== 16) return null;
  if (audioFormat === 3 && bitsPerSample !== 32) return null;

  const end = Math.min(view.byteLength, dataOffset + dataBytes);
  const available = end - dataOffset;
  if (available <= 0) return null;

  if (audioFormat === 1) {
    const frameCount = Math.floor(available / (2 * channels));
    if (frameCount <= 0) return null;
    const interleaved = new Float32Array(frameCount * channels);
    let o = 0;
    for (let i = 0; i < frameCount; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const sample = view.getInt16(dataOffset + (i * channels + c) * 2, true);
        interleaved[o++] = sample / (sample < 0 ? 0x8000 : 0x7fff);
      }
    }
    return { samples: downmixToMono(interleaved, channels), sampleRate };
  }

  const frameCount = Math.floor(available / (4 * channels));
  if (frameCount <= 0) return null;
  const interleaved = new Float32Array(frameCount * channels);
  let o = 0;
  for (let i = 0; i < frameCount; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      interleaved[o++] = view.getFloat32(dataOffset + (i * channels + c) * 4, true);
    }
  }
  return { samples: downmixToMono(interleaved, channels), sampleRate };
}

/**
 * Convert a controller capture Blob into 16 kHz mono Float32 PCM.
 * Uses direct WAV parse when possible; otherwise decodeAudioData.
 */
export async function blobToWhisperPcm(
  blob: Blob,
  options: {
    signal?: AbortSignal;
    audioContext?: AudioContext;
    maxBytes?: number;
  } = {},
): Promise<Float32Array> {
  if (options.signal?.aborted) {
    throw voiceError("aborted");
  }
  const maxBytes = options.maxBytes ?? MAX_SPEECH_AUDIO_BYTES;
  if (blob.size <= 0) throw voiceError("empty_audio");
  if (blob.size > maxBytes) throw voiceError("audio_too_large");

  const mime = normalizeAcceptedAudioMime(blob.type || "audio/wav");
  if (!mime && blob.type) {
    // Empty type is allowed for VAD WAV blobs; unknown non-empty types fail closed.
    throw voiceError("unsupported_mime");
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await blob.arrayBuffer();
  } catch {
    if (options.signal?.aborted) throw voiceError("aborted");
    throw voiceError("audio_capture");
  }
  if (options.signal?.aborted) throw voiceError("aborted");
  if (buffer.byteLength <= 0) throw voiceError("empty_audio");
  if (buffer.byteLength > maxBytes) throw voiceError("audio_too_large");

  const parsed = tryParseWavPcm(buffer);
  if (parsed) {
    const mono =
      parsed.sampleRate === LOCAL_STT_TARGET_SAMPLE_RATE_HZ
        ? parsed.samples
        : resampleMono(parsed.samples, parsed.sampleRate, LOCAL_STT_TARGET_SAMPLE_RATE_HZ);
    const clean = sanitizePcm(mono);
    if ("code" in clean) throw clean;
    return clean;
  }

  const Ctx =
    options.audioContext?.constructor ??
    (typeof AudioContext !== "undefined"
      ? AudioContext
      : typeof window !== "undefined"
        ? ((window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
          null)
        : null);
  if (!Ctx && !options.audioContext) {
    throw voiceError("unsupported");
  }

  const context = options.audioContext ?? new (Ctx as typeof AudioContext)();
  const ownsContext = !options.audioContext;
  try {
    const decoded = await context.decodeAudioData(buffer.slice(0));
    if (options.signal?.aborted) throw voiceError("aborted");
    const channelCount = Math.max(1, decoded.numberOfChannels);
    const length = decoded.length;
    if (length <= 0) throw voiceError("empty_audio");
    const interleaved = new Float32Array(length * channelCount);
    for (let c = 0; c < channelCount; c += 1) {
      const channel = decoded.getChannelData(c);
      for (let i = 0; i < length; i += 1) {
        interleaved[i * channelCount + c] = channel[i] ?? 0;
      }
    }
    const mono = downmixToMono(interleaved, channelCount);
    const resampled =
      decoded.sampleRate === LOCAL_STT_TARGET_SAMPLE_RATE_HZ
        ? mono
        : resampleMono(mono, decoded.sampleRate, LOCAL_STT_TARGET_SAMPLE_RATE_HZ);
    const clean = sanitizePcm(resampled);
    if ("code" in clean) throw clean;
    return clean;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      throw error;
    }
    if (options.signal?.aborted) throw voiceError("aborted");
    throw voiceError("unsupported_mime");
  } finally {
    if (ownsContext) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}
