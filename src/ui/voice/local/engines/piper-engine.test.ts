import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryOpfs } from "../opfs-mock.ts";
const createSession = vi.fn();
const predict = vi.fn();
const download = vi.fn(async (_voiceId: string) => {
  throw new Error("Junban blocks download");
});
const sessionSingleton: { _instance: unknown } = { _instance: null };

function makeWav(bytes = 64): ArrayBuffer {
  const wav = new Uint8Array(bytes);
  wav.set([0x52, 0x49, 0x46, 0x46], 0);
  wav.set([0x57, 0x41, 0x56, 0x45], 8);
  return wav.buffer;
}

vi.mock("@mintplex-labs/piper-tts-web", () => ({
  TtsSession: {
    create: (options: unknown) => createSession(options),
    get _instance() {
      return sessionSingleton._instance;
    },
    set _instance(value: unknown) {
      sessionSingleton._instance = value;
    },
  },
  download: (voiceId: string) => download(voiceId),
}));

vi.mock("../same-origin-assets.ts", () => ({
  loadPiperRuntimeAssets: async () => ({
    onnxWasmBaseUrl: "/assets/ort-piper/",
    ortWasmPaths: {
      mjs: "/assets/ort-piper/ort-wasm-simd-threaded.mjs",
      wasm: "/assets/ort-piper/ort-wasm-simd-threaded.wasm",
    },
    piperDataUrl: "/assets/piper_phonemize.data",
    piperWasmUrl: "/assets/piper_phonemize.wasm",
  }),
}));

describe("piper engine owner", () => {
  beforeEach(() => {
    installMemoryOpfs();
    createSession.mockReset();
    predict.mockReset();
    download.mockClear();
    sessionSingleton._instance = { keep: true };
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates TtsSession with exact LJ Speech voice and same-origin wasmPaths", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => true),
        openVerifiedFile: vi.fn(async (_pkg: string, path: string) => {
          const name = path.split("/").at(-1) ?? "x";
          return new File([new Uint8Array([1, 2, 3])], name);
        }),
      };
    });

    predict.mockResolvedValue(new Blob([makeWav()], { type: "audio/x-wav" }));
    createSession.mockResolvedValue({
      voiceId: "en_US-ljspeech-medium",
      predict,
    });

    const { loadPiperEngine, PIPER_VOICE_ID } = await import("./load-piper.ts");
    const handle = await loadPiperEngine();

    expect(PIPER_VOICE_ID).toBe("en_US-ljspeech-medium");
    expect(createSession).toHaveBeenCalledWith({
      voiceId: "en_US-ljspeech-medium",
      wasmPaths: {
        onnxWasm: {
          mjs: "/assets/ort-piper/ort-wasm-simd-threaded.mjs",
          wasm: "/assets/ort-piper/ort-wasm-simd-threaded.wasm",
        },
        piperData: "/assets/piper_phonemize.data",
        piperWasm: "/assets/piper_phonemize.wasm",
      },
    });
    expect(download).not.toHaveBeenCalled();

    const audio = await handle.synthesize("Piper says hello");
    expect(predict).toHaveBeenCalledWith("Piper says hello");
    expect(audio.format).toBe("wav");
    expect(audio.wav.byteLength).toBeGreaterThanOrEqual(44);

    await handle.dispose();
    expect(sessionSingleton._instance).toBeNull();
  });

  it("never uses HFC default voice", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => true),
        openVerifiedFile: vi.fn(async () => new File([new Uint8Array([1])], "x")),
      };
    });
    createSession.mockResolvedValue({
      voiceId: "en_US-hfc_female-medium",
      predict,
    });
    const { loadPiperEngine } = await import("./load-piper.ts");
    await expect(loadPiperEngine()).rejects.toMatchObject({ code: "load_failed" });
    const args = createSession.mock.calls[0]?.[0] as { voiceId: string };
    expect(args.voiceId).toBe("en_US-ljspeech-medium");
    expect(args.voiceId).not.toContain("hfc");
  });

  it("fails closed on cache miss and does not call download", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => false),
      };
    });
    const { loadPiperEngine } = await import("./load-piper.ts");
    await expect(loadPiperEngine()).rejects.toMatchObject({ code: "cache_miss" });
    expect(createSession).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects empty synthesis text", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => true),
        openVerifiedFile: vi.fn(async () => new File([new Uint8Array([1])], "x")),
      };
    });
    createSession.mockResolvedValue({
      voiceId: "en_US-ljspeech-medium",
      predict,
    });
    const { loadPiperEngine } = await import("./load-piper.ts");
    const handle = await loadPiperEngine();
    await expect(handle.synthesize("")).rejects.toMatchObject({
      code: "invalid_text",
      name: "LocalVoiceClientError",
    });
  });
});
