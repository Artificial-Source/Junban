import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryOpfs } from "../opfs-mock.ts";
const pipelineMock = vi.fn();
const disposeMock = vi.fn(async () => undefined);
const env = {
  allowRemoteModels: true,
  allowLocalModels: false,
  useBrowserCache: true,
  useCustomCache: false,
  customCache: null as unknown,
  backends: { onnx: { wasm: { wasmPaths: "/__junban_local_voice_wasm_unconfigured__/" } } },
  version: "3.8.1",
};

vi.mock("@huggingface/transformers", () => ({
  env,
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

vi.mock("../same-origin-assets.ts", () => ({
  loadWhisperRuntimeAssets: async () => ({
    ortWasmBaseUrl: "/assets/ort-whisper/",
    ortWasmPaths: {
      mjs: "/assets/ort-whisper/ort-wasm-simd-threaded.jsep.mjs",
      wasm: "/assets/ort-whisper/ort-wasm-simd-threaded.jsep.wasm",
    },
  }),
}));

describe("whisper engine owner", () => {
  beforeEach(() => {
    installMemoryOpfs();
    pipelineMock.mockReset();
    disposeMock.mockReset();
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.useCustomCache = false;
    env.customCache = null;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs q4/wasm pipeline at exact repo+revision and transcribes", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => true),
      };
    });

    const asr = Object.assign(
      vi.fn(async () => ({ text: "  hello world  " })),
      {
        dispose: disposeMock,
      },
    );
    pipelineMock.mockResolvedValue(asr);

    const { loadWhisperEngine, WHISPER_PACKAGE_ID } = await import("./load-whisper.ts");
    const { getLocalVoicePackage } = await import("../manifest.ts");
    const pkg = getLocalVoicePackage(WHISPER_PACKAGE_ID);

    const handle = await loadWhisperEngine();
    expect(pipelineMock).toHaveBeenCalledWith("automatic-speech-recognition", pkg.repo, {
      dtype: "q4",
      revision: pkg.revision,
      device: "wasm",
    });
    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
    expect(env.useBrowserCache).toBe(false);
    expect(env.useCustomCache).toBe(true);
    expect(env.backends.onnx.wasm.wasmPaths).toEqual({
      mjs: "/assets/ort-whisper/ort-wasm-simd-threaded.jsep.mjs",
      wasm: "/assets/ort-whisper/ort-wasm-simd-threaded.jsep.wasm",
    });

    const text = await handle.transcribe(new Float32Array([0.1, 0.2, 0.0]));
    expect(text).toBe("hello world");
    expect(asr).toHaveBeenCalledOnce();

    await handle.dispose();
    expect(disposeMock).toHaveBeenCalledOnce();
  });

  it("fails closed on cache miss without constructing a pipeline", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => false),
      };
    });
    pipelineMock.mockClear();
    const { loadWhisperEngine } = await import("./load-whisper.ts");
    await expect(loadWhisperEngine()).rejects.toMatchObject({ code: "cache_miss" });
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("rejects empty or non-finite transcripts and invalid samples", async () => {
    vi.doMock("../verify-fetch.ts", async () => {
      const actual =
        await vi.importActual<typeof import("../verify-fetch.ts")>("../verify-fetch.ts");
      return {
        ...actual,
        reverifyCachedPackage: vi.fn(async () => true),
      };
    });
    const asr = Object.assign(
      vi.fn(async () => ({ text: "   " })),
      { dispose: disposeMock },
    );
    pipelineMock.mockResolvedValue(asr);
    const { loadWhisperEngine } = await import("./load-whisper.ts");
    const handle = await loadWhisperEngine();
    await expect(handle.transcribe(new Float32Array([1, 2]))).rejects.toMatchObject({
      code: "infer_failed",
      name: "LocalVoiceClientError",
    });
    await expect(handle.transcribe(new Float32Array([Number.NaN]))).rejects.toMatchObject({
      code: "invalid_audio",
    });
  });
});
