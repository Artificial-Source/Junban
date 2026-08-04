import { afterEach, describe, expect, it, vi } from "vitest";
import { float32ToWav } from "./audio-utils";

const getLocalEngineStatus = vi.fn();
const playPcmWithAudioContext = vi.fn();
const playWavBlob = vi.fn();

vi.mock("./local/index", () => ({
  getLocalEngineStatus: (...args: unknown[]) => getLocalEngineStatus(...args),
  createLocalWhisperClient: () => createMockWhisper(),
  createLocalKokoroClient: () => createMockKokoro(),
  createLocalPiperClient: () => createMockPiper(),
}));

vi.mock("./local-adapter-playback", () => ({
  playPcmWithAudioContext: (...args: unknown[]) => playPcmWithAudioContext(...args),
  playWavBlob: (...args: unknown[]) => playWavBlob(...args),
}));

const { createLocalTtsAdapter, createLocalWhisperAdapter } = await import("./local-adapters");

function createMockWhisper() {
  return {
    async load() {
      return {
        packageId: "whisper-tiny.en-q4",
        modelId: "m",
        revision: "r",
        generation: 1,
      };
    },
    async transcribe(samples: Float32Array, generation: number) {
      return { text: `t:${samples.length}:${generation}`, generation };
    },
    async dispose() {},
  };
}

function createMockKokoro() {
  return {
    async load() {
      return {
        packageId: "kokoro-82m-v1-q8",
        modelId: "m",
        revision: "r",
        generation: 2,
      };
    },
    async synthesize(text: string, generation: number) {
      return {
        format: "pcm-f32" as const,
        sampleRate: 24_000,
        channels: 1,
        pcm: new Float32Array([0.1, 0.2, text.length * 0.01]),
        generation,
      };
    },
    async dispose() {},
  };
}

function createMockPiper() {
  return {
    async load() {
      return {
        packageId: "piper-en_US-ljspeech-medium",
        modelId: "m",
        revision: "r",
        generation: 3,
      };
    },
    async synthesize(_text: string, generation: number) {
      const wav = await float32ToWav(new Float32Array([0.2, 0.1]), 22_050).arrayBuffer();
      return {
        format: "wav" as const,
        sampleRate: 22_050,
        channels: 1,
        wav,
        generation,
      };
    },
    async dispose() {},
  };
}

afterEach(() => {
  getLocalEngineStatus.mockReset();
  playPcmWithAudioContext.mockReset();
  playWavBlob.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local adapters", () => {
  it("whisper adapter loads only when verified and transcribes WAV blobs", async () => {
    getLocalEngineStatus.mockResolvedValue({
      verified: true,
      packageId: "whisper-tiny.en-q4",
    });
    const statuses: string[] = [];
    const adapter = createLocalWhisperAdapter({
      packageId: "whisper-tiny.en-q4",
      onStatus: (s) => statuses.push(s),
    });
    await adapter.prepare();
    expect(adapter.status).toBe("ready");
    const wav = float32ToWav(new Float32Array([0.1, 0.2, 0.3]), 16_000);
    const text = await adapter.transcribe(wav);
    expect(text).toContain("t:3:1");
    adapter.dispose();
    adapter.dispose();
    expect(adapter.status).toBe("unavailable");
    expect(statuses).toContain("ready");
  });

  it("whisper adapter surfaces unavailable when cache is missing", async () => {
    getLocalEngineStatus.mockResolvedValue({
      verified: false,
      packageId: "whisper-tiny.en-q4",
    });
    const adapter = createLocalWhisperAdapter({ packageId: "whisper-tiny.en-q4" });
    await adapter.prepare();
    expect(adapter.status).toBe("unavailable");
    await expect(
      adapter.transcribe(new Blob([new Uint8Array([1])], { type: "audio/wav" })),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("kokoro adapter synthesizes PCM, cancels playback, and disposes", async () => {
    getLocalEngineStatus.mockResolvedValue({
      verified: true,
      packageId: "kokoro-82m-v1-q8",
    });
    const stop = vi.fn();
    playPcmWithAudioContext.mockImplementation(() => ({
      done: Promise.resolve(),
      stop,
    }));

    const adapter = createLocalTtsAdapter({ packageId: "kokoro-82m-v1-q8" });
    await expect(adapter.prepare()).resolves.toBeUndefined();
    expect(adapter.status).toBe("ready");

    const speakPromise = adapter.speak("hi");
    await expect(speakPromise).resolves.toBeUndefined();
    expect(playPcmWithAudioContext).toHaveBeenCalledTimes(1);

    // Cancel while playback is outstanding.
    let resolveDone: (() => void) | undefined;
    playPcmWithAudioContext.mockImplementationOnce(() => ({
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      stop: () => {
        stop();
        resolveDone?.();
      },
    }));
    const hanging = adapter.speak("hang");
    // Yield so synthesize + play setup run.
    await Promise.resolve();
    await Promise.resolve();
    adapter.cancel();
    await expect(hanging).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalled();
    adapter.dispose();
    expect(adapter.status).toBe("unavailable");
  });

  it("piper adapter synthesizes wav and cleans via playback handle", async () => {
    getLocalEngineStatus.mockResolvedValue({
      verified: true,
      packageId: "piper-en_US-ljspeech-medium",
    });
    const stop = vi.fn();
    playWavBlob.mockReturnValue({
      done: Promise.resolve(),
      stop,
    });

    const adapter = createLocalTtsAdapter({ packageId: "piper-en_US-ljspeech-medium" });
    await adapter.prepare();
    await expect(adapter.speak("hello")).resolves.toBeUndefined();
    expect(playWavBlob).toHaveBeenCalled();
    const blobArg = playWavBlob.mock.calls[0]?.[0] as Blob;
    expect(blobArg.type).toBe("audio/wav");
    adapter.dispose();
  });
});
