/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  concatFloat32,
  filenameForAudioMime,
  float32ToWav,
  normalizeAcceptedAudioMime,
  pcmExceedsAudioCeiling,
  selectMediaRecorderMime,
  stripMimeParameters,
  validateAudioBlob,
} from "./audio-utils";
import { MAX_SPEECH_AUDIO_BYTES } from "./types";

describe("audio-utils", () => {
  it("strips MIME parameters and normalizes accepted types", () => {
    expect(stripMimeParameters("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeAcceptedAudioMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeAcceptedAudioMime("audio/wav")).toBe("audio/wav");
    expect(normalizeAcceptedAudioMime("audio/foo")).toBeNull();
    expect(normalizeAcceptedAudioMime("")).toBeNull();
  });

  it("selects a supported MediaRecorder MIME without parameters", () => {
    expect(selectMediaRecorderMime((m) => m === "audio/mp4")).toBe("audio/mp4");
    // No candidate and no MediaRecorder global → unsupported.
    expect(selectMediaRecorderMime(() => false)).toBe(
      typeof MediaRecorder === "undefined" ? null : "",
    );
  });

  it("validates empty, oversized, and unsupported blobs before fetch", () => {
    expect(validateAudioBlob(new Blob([]))).toMatchObject({ code: "empty_audio" });
    expect(
      validateAudioBlob(new Blob([new Uint8Array(10)], { type: "audio/webm;codecs=opus" })),
    ).toMatchObject({ mime: "audio/webm", byteLength: 10 });
    expect(
      validateAudioBlob(new Blob([new Uint8Array(4)], { type: "application/octet-stream" })),
    ).toMatchObject({ code: "unsupported_mime" });
    const big = new Blob([new Uint8Array(MAX_SPEECH_AUDIO_BYTES + 1)], { type: "audio/wav" });
    expect(validateAudioBlob(big)).toMatchObject({ code: "audio_too_large" });
  });

  it("encodes 16 kHz mono float32 PCM as a canonical WAV", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = float32ToWav(samples, 16_000);
    expect(wav.type).toBe("audio/wav");
    const buf = new Uint8Array(await wav.arrayBuffer());
    expect(String.fromCharCode(buf[0], buf[1], buf[2], buf[3])).toBe("RIFF");
    expect(String.fromCharCode(buf[8], buf[9], buf[10], buf[11])).toBe("WAVE");
    expect(buf.byteLength).toBe(44 + samples.length * 2);
  });

  it("concatenates float chunks and bounds PCM ceilings", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([3]);
    expect(Array.from(concatFloat32([a, b]))).toEqual([1, 2, 3]);
    expect(pcmExceedsAudioCeiling(0)).toBe(false);
    expect(pcmExceedsAudioCeiling((MAX_SPEECH_AUDIO_BYTES - 44) / 2 + 1)).toBe(true);
  });

  it("maps MIME types to filenames", () => {
    expect(filenameForAudioMime("audio/webm")).toBe("audio.webm");
    expect(filenameForAudioMime("audio/mpeg")).toBe("audio.mp3");
  });
});
