import { describe, expect, it } from "vitest";
import {
  LOCAL_VOICE_MAX_PCM_BYTES,
  LOCAL_VOICE_MAX_SYNTHESIS_TEXT_BYTES,
  LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ,
  boundTranscript,
  isLocalVoiceRequest,
  isLocalVoiceResponse,
  localVoiceError,
  validatePcmAudioOut,
  validateSynthesisText,
  validateWavAudioOut,
  validateWhisperPcm,
} from "./protocol.ts";

describe("local voice protocol", () => {
  it("accepts only known discriminated request shapes", () => {
    expect(isLocalVoiceRequest({ type: "ping", requestId: "a", generation: 1 })).toBe(true);
    expect(
      isLocalVoiceRequest({
        type: "transcribe",
        requestId: "a",
        generation: 1,
        pcm: new ArrayBuffer(8),
        sampleRate: 16_000,
      }),
    ).toBe(true);
    expect(isLocalVoiceRequest({ type: "load" })).toBe(false);
    expect(isLocalVoiceRequest({ type: "explode", requestId: "a", generation: 1 })).toBe(false);
  });

  it("accepts only known response shapes", () => {
    expect(isLocalVoiceResponse({ type: "pong", requestId: "a", generation: 1 })).toBe(true);
    expect(
      isLocalVoiceResponse({
        type: "error",
        requestId: "a",
        generation: 1,
        code: "timeout",
        message: "x",
      }),
    ).toBe(true);
    expect(isLocalVoiceResponse({ type: "error", requestId: "a", generation: 1 })).toBe(false);
  });

  it("validates whisper PCM bounds and finiteness", () => {
    const ok = new Float32Array([0, 0.1, -0.2]);
    expect(validateWhisperPcm(ok.buffer, LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ).ok).toBe(true);

    expect(validateWhisperPcm(ok.buffer, 8_000).ok).toBe(false);
    expect(validateWhisperPcm(new ArrayBuffer(0), 16_000).ok).toBe(false);

    const bad = new Float32Array([0, Number.NaN]);
    expect(validateWhisperPcm(bad.buffer, 16_000).ok).toBe(false);

    const over = new ArrayBuffer(LOCAL_VOICE_MAX_PCM_BYTES + 4);
    expect(validateWhisperPcm(over, 16_000).ok).toBe(false);
  });

  it("validates synthesis text bounds and controls", () => {
    expect(validateSynthesisText("hello").ok).toBe(true);
    expect(validateSynthesisText("   ").ok).toBe(false);
    expect(validateSynthesisText("bad\u0000text").ok).toBe(false);
    expect(validateSynthesisText("a".repeat(LOCAL_VOICE_MAX_SYNTHESIS_TEXT_BYTES + 1)).ok).toBe(
      false,
    );
  });

  it("bounds transcripts and audio outputs", () => {
    expect(boundTranscript(" hi ").ok).toBe(true);
    expect(boundTranscript("   ").ok).toBe(false);

    const pcm = new Float32Array([0.1, -0.1]);
    const pcmOk = validatePcmAudioOut(pcm, 24_000, 1);
    expect(pcmOk.ok).toBe(true);

    const wav = new Uint8Array(44);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(validateWavAudioOut(wav.buffer).ok).toBe(true);
    expect(validateWavAudioOut(new ArrayBuffer(8)).ok).toBe(false);
  });

  it("emits stable redacted error messages", () => {
    const err = localVoiceError("infer_failed", "r1", 2);
    expect(err.message).toBe("Local voice inference failed");
    expect(err.message).not.toMatch(/stack|transcript|model/i);
  });
});
