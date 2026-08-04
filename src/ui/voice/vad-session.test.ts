/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVadSession, type MicVadLike, type VadEngineHandleLike } from "./vad-session";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function mockEngine(hooks: {
  onConstruct?: (opts: Record<string, unknown>) => void;
  /** When true, simulate MicVAD: assign onnxWASMBasePath then call ortConfig. */
  applyOrtConfig?: boolean;
  vad?: Partial<MicVadLike>;
}): VadEngineHandleLike {
  const vad: MicVadLike = {
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    listening: false,
    ...hooks.vad,
  };
  return {
    workletUrl: "/assets/vad.worklet.bundle.min.js",
    modelUrl: "/assets/silero_vad_v5.onnx",
    ortWasmBaseUrl: "/assets/",
    ortWasmPaths: {
      mjs: "/assets/ort-wasm-simd-threaded-abc123.mjs",
      wasm: "/assets/ort-wasm-simd-threaded-abc123.wasm",
    },
    MicVAD: {
      new: vi.fn(async (opts: Record<string, unknown>) => {
        if (hooks.applyOrtConfig) {
          const ort = {
            env: {
              wasm: {
                wasmPaths: opts.onnxWASMBasePath as string,
              },
            },
          };
          const ortConfig = opts.ortConfig as ((o: typeof ort) => void) | undefined;
          ortConfig?.(ort);
          (opts as { __ortAfterConfig?: unknown }).__ortAfterConfig = ort.env.wasm.wasmPaths;
        }
        hooks.onConstruct?.(opts);
        return vad;
      }),
    },
    dispose: vi.fn(),
  };
}

describe("vad-session", () => {
  it("loads v5 with startOnLoad false, grace period, and same-origin roots", async () => {
    let captured: Record<string, unknown> = {};
    const engine = mockEngine({
      onConstruct: (opts) => {
        captured = opts;
      },
    });
    const streamStop = vi.fn();
    const stream = { getTracks: () => [{ stop: streamStop }] } as unknown as MediaStream;
    const session = createVadSession({
      gracePeriodMs: 800,
      loadEngine: async () => engine,
      getUserMedia: async () => stream,
    });
    await session.start();
    expect(captured).toMatchObject({
      model: "v5",
      startOnLoad: false,
      redemptionMs: 800,
    });
    expect(String(captured.onnxWASMBasePath)).toContain("/assets");
    expect(typeof captured.ortConfig).toBe("function");
    expect(engine.MicVAD.new).toHaveBeenCalled();
    // Shared mic lifecycle: getStream is invoked by MicVAD.start in production;
    // destroy remains idempotent even when the mock never opened tracks.
    await (captured.getStream as () => Promise<MediaStream>)();
    await session.destroy();
    expect(streamStop).toHaveBeenCalled();
  });

  it("installs object-form exact ORT mjs+wasm URLs via ortConfig after onnxWASMBasePath", async () => {
    let captured: Record<string, unknown> = {};
    const engine = mockEngine({
      applyOrtConfig: true,
      onConstruct: (opts) => {
        captured = opts;
      },
    });
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const session = createVadSession({
      gracePeriodMs: 0,
      loadEngine: async () => engine,
      getUserMedia: async () => stream,
    });
    await session.start();

    // Directory prefix is still supplied (MicVAD sets it first)...
    expect(String(captured.onnxWASMBasePath)).toMatch(/\/assets\/?$/);
    // ...then ortConfig overwrites with the exact hashed object form.
    expect(captured.__ortAfterConfig).toEqual({
      mjs: "/assets/ort-wasm-simd-threaded-abc123.mjs",
      wasm: "/assets/ort-wasm-simd-threaded-abc123.wasm",
    });

    // Direct ortConfig call also installs the same object (defensive).
    const ort = {
      env: { wasm: { wasmPaths: "/wrong/" as string | { mjs: string; wasm: string } } },
    };
    (captured.ortConfig as (o: typeof ort) => void)(ort);
    expect(ort.env.wasm.wasmPaths).toEqual({
      mjs: "/assets/ort-wasm-simd-threaded-abc123.mjs",
      wasm: "/assets/ort-wasm-simd-threaded-abc123.wasm",
    });

    await session.destroy();
  });

  it("buffers speech through grace, emits WAV, and supports pause/destroy", async () => {
    let opts: Record<string, unknown> = {};
    const engine = mockEngine({
      onConstruct: (o) => {
        opts = o;
      },
    });
    const onSpeechEnd = vi.fn();
    const onGrace = vi.fn();
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const session = createVadSession({
      gracePeriodMs: 20,
      loadEngine: async () => engine,
      getUserMedia: async () => stream,
      callbacks: { onSpeechEnd, onGraceChange: onGrace },
    });
    await session.start();
    const samples = new Float32Array(1600).fill(0.1);
    (opts.onSpeechEnd as (a: Float32Array) => void)(samples);
    expect(onGrace).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
    const wav = onSpeechEnd.mock.calls[0]?.[0] as Blob;
    expect(wav.type).toBe("audio/wav");
    expect(wav.size).toBeGreaterThan(44);

    await session.pause();
    await session.resume();
    await session.destroy();
    await session.destroy(); // idempotent
  });

  it("does not import local engines at module evaluation", async () => {
    const source = await import("./vad-session.ts?raw").then((m) => m.default as string);
    expect(source).not.toMatch(/from\s+["']@ricky0123\/vad-web["']/);
    expect(source).not.toMatch(/from\s+["']@huggingface\/transformers["']/);
    expect(source).toContain('import("./vad-loader.ts")');
  });

  it("vad-loader imports both exact hashed ORT mjs and wasm asset ids", async () => {
    const source = await import("./vad-loader.ts?raw").then((m) => m.default as string);
    expect(source).toContain('import("@junban/ort-vad-wasm?url")');
    expect(source).toContain('import("@junban/ort-vad-mjs?url")');
    expect(source).toContain("ortWasmPaths");
    expect(source).not.toMatch(/from\s+["']@ricky0123\/vad-web["']/);
    // Dynamic package import only — no top-level engine evaluation.
    expect(source).toMatch(/import\(["']@ricky0123\/vad-web["']\)/);
  });
});
