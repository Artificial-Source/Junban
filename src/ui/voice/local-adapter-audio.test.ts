import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_STT_TARGET_SAMPLE_RATE_HZ,
  blobToWhisperPcm,
  downmixToMono,
  resampleMono,
  sanitizePcm,
  tryParseWavPcm,
} from "./local-adapter-audio";
import { playPcmWithAudioContext, playWavBlob } from "./local-adapter-playback";
import { float32ToWav } from "./audio-utils";

describe("local-adapter-audio", () => {
  it("downmixes and resamples to 16 kHz mono", () => {
    const stereo = new Float32Array([1, -1, 0.5, -0.5]);
    const mono = downmixToMono(stereo, 2);
    expect(Array.from(mono)).toEqual([0, 0]);

    const source = new Float32Array([0, 1, 0, -1]);
    const out = resampleMono(source, 8_000, LOCAL_STT_TARGET_SAMPLE_RATE_HZ);
    expect(out.length).toBe(8);
    expect(sanitizePcm(out)).toBe(out);
  });

  it("parses int16 WAV and bounds empty/non-finite PCM", async () => {
    const samples = new Float32Array([0.25, -0.5, 0.0]);
    const wav = float32ToWav(samples, 16_000);
    const buffer = await wav.arrayBuffer();
    const parsed = tryParseWavPcm(buffer);
    expect(parsed?.sampleRate).toBe(16_000);
    expect(parsed?.samples.length).toBe(3);

    expect(sanitizePcm(new Float32Array(0))).toMatchObject({ code: "empty_audio" });
    expect(sanitizePcm(new Float32Array([Number.NaN]))).toMatchObject({ code: "invalid_response" });
  });

  it("converts WAV blobs to whisper PCM without AudioContext when possible", async () => {
    const samples = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const wav = float32ToWav(samples, 16_000);
    const pcm = await blobToWhisperPcm(wav);
    expect(pcm.length).toBe(4);
    expect(pcm[0]).toBeCloseTo(0.1, 2);
  });

  it("rejects oversized blobs before decode", async () => {
    const huge = new Blob([new Uint8Array(26 * 1024 * 1024)], { type: "audio/wav" });
    await expect(blobToWhisperPcm(huge)).rejects.toMatchObject({ code: "audio_too_large" });
  });

  it("playPcm and playWav clean up on stop", async () => {
    const stopSpy = vi.fn();
    const closeSpy = vi.fn(async () => undefined);
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: stopSpy,
      disconnect: vi.fn(),
      onended: null as null | (() => void),
    };
    const ctx = {
      state: "running",
      createBuffer: vi.fn(() => {
        const channel = new Float32Array(4);
        return {
          copyToChannel: (data: Float32Array) => {
            channel.set(data.subarray(0, channel.length));
          },
        } as unknown as AudioBuffer;
      }),
      createBufferSource: () => source as unknown as AudioBufferSourceNode,
      resume: vi.fn(async () => undefined),
      close: closeSpy,
    } as unknown as AudioContext;

    const playback = playPcmWithAudioContext(new Float32Array([0.1, 0.2, 0.3, 0.4]), 16_000, {
      audioContext: ctx,
    });
    playback.stop();
    expect(stopSpy).toHaveBeenCalled();

    const revoke = vi.fn();
    const audio = {
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      play: vi.fn(async () => undefined),
      preload: "",
      src: "",
      onended: null as null | (() => void),
      onerror: null as null | (() => void),
    };
    const wavPlayback = playWavBlob(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), {
      audioElement: audio as unknown as HTMLAudioElement,
      createObjectUrl: () => "blob:test",
      revokeObjectUrl: revoke,
    });
    wavPlayback.stop();
    expect(audio.pause).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:test");
  });
});
