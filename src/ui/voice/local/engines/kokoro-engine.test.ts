import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryOpfs } from "../opfs-mock.ts";
const fromPretrained = vi.fn();
const generate = vi.fn();
const modelDispose = vi.fn(async () => undefined);
const kokoroEnv = { wasmPaths: "" };

vi.mock("kokoro-js", () => ({
  KokoroTTS: { from_pretrained: (...args: unknown[]) => fromPretrained(...args) },
  env: kokoroEnv,
}));

const transformersEnv = {
  allowRemoteModels: true,
  allowLocalModels: false,
  useBrowserCache: true,
  useCustomCache: false,
  customCache: null as unknown,
  backends: { onnx: { wasm: { wasmPaths: "/sentinel/" } } },
};

vi.mock("@huggingface/transformers", () => ({
  env: transformersEnv,
}));

vi.mock("../same-origin-assets.ts", () => ({
  loadKokoroRuntimeAssets: async () => ({
    ortWasmBaseUrl: "/assets/ort-kokoro/",
    ortWasmPaths: {
      mjs: "/assets/ort-kokoro/ort-wasm-simd-threaded.jsep.mjs",
      wasm: "/assets/ort-kokoro/ort-wasm-simd-threaded.jsep.wasm",
    },
  }),
}));

describe("kokoro engine owner", () => {
  beforeEach(() => {
    installMemoryOpfs();
    fromPretrained.mockReset();
    generate.mockReset();
    modelDispose.mockReset();
    kokoroEnv.wasmPaths = "";
    vi.resetModules();

    // Minimal Cache API
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        put: async (req: RequestInfo, res: Response) => {
          const url =
            typeof req === "string" ? req : req instanceof Request ? req.url : String(req);
          store.set(url, res);
        },
        match: async (req: RequestInfo) => {
          const url =
            typeof req === "string" ? req : req instanceof Request ? req.url : String(req);
          return store.get(url);
        },
        delete: async (req: RequestInfo) => {
          const url =
            typeof req === "string" ? req : req instanceof Request ? req.url : String(req);
          return store.delete(url);
        },
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("instantiates q8/wasm with exact voice af_heart only", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => true),
        streamVerifiedFile: async function* () {
          yield new Uint8Array([1, 2, 3, 4]);
        },
      };
    });

    generate.mockResolvedValue({
      audio: new Float32Array([0.1, -0.2, 0.0]),
      sampling_rate: 24_000,
    });
    fromPretrained.mockResolvedValue({
      model: { dispose: modelDispose },
      generate,
    });

    const { loadKokoroEngine, KOKORO_VOICE_ID } = await import("./load-kokoro.ts");
    const { getLocalVoicePackage } = await import("../manifest.ts");
    const { KOKORO_PACKAGE_ID } = await import("./load-kokoro.ts");
    const pkg = getLocalVoicePackage(KOKORO_PACKAGE_ID);

    const handle = await loadKokoroEngine();
    expect(fromPretrained).toHaveBeenCalledWith(pkg.repo, { dtype: "q8", device: "wasm" });
    expect(handle.voiceId).toBe("af_heart");
    expect(KOKORO_VOICE_ID).toBe("af_heart");
    expect(kokoroEnv.wasmPaths).toBe("/assets/ort-kokoro/");
    expect(transformersEnv.allowRemoteModels).toBe(false);
    expect(transformersEnv.allowLocalModels).toBe(true);
    expect(transformersEnv.useCustomCache).toBe(true);

    const audio = await handle.synthesize("Hello there");
    expect(generate).toHaveBeenCalledWith("Hello there", { voice: "af_heart" });
    expect(audio.pcm.length).toBe(3);
    expect(audio.sampleRate).toBe(24_000);
    expect(audio.transferable.byteLength).toBe(12);

    await handle.dispose();
    expect(modelDispose).toHaveBeenCalledOnce();
  });

  it("fails closed when verified voice/cache is missing", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => false),
      };
    });
    const { loadKokoroEngine } = await import("./load-kokoro.ts");
    await expect(loadKokoroEngine()).rejects.toMatchObject({ code: "cache_miss" });
    expect(fromPretrained).not.toHaveBeenCalled();
  });

  it("rejects invalid synthesis text", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => true),
        streamVerifiedFile: async function* () {
          yield new Uint8Array([9]);
        },
      };
    });
    generate.mockResolvedValue({
      audio: new Float32Array([0.1]),
      sampling_rate: 24_000,
    });
    fromPretrained.mockResolvedValue({
      model: { dispose: modelDispose },
      generate,
    });
    const { loadKokoroEngine } = await import("./load-kokoro.ts");
    const handle = await loadKokoroEngine();
    await expect(handle.synthesize("  ")).rejects.toMatchObject({
      code: "invalid_text",
      name: "LocalVoiceClientError",
    });
  });
});
