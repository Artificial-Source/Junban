import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { KokoroWorkerResponse } from "../../../../src/ai/voice/workers/kokoro-worker-types.js";

// Mock Worker class
class MockWorker {
  url: string | URL;
  options: any;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  private messageListeners: ((e: MessageEvent) => void)[] = [];
  private errorListeners: (() => void)[] = [];

  constructor(url: string | URL, options?: any) {
    this.url = url;
    this.options = options;
    MockWorker.instances.push(this);
  }

  postMessage = vi.fn();
  terminate = vi.fn();

  addEventListener(type: string, listener: any) {
    if (type === "message") this.messageListeners.push(listener);
    if (type === "error") this.errorListeners.push(listener);
  }

  removeEventListener(type: string, listener: any) {
    if (type === "message")
      this.messageListeners = this.messageListeners.filter((l) => l !== listener);
    if (type === "error") this.errorListeners = this.errorListeners.filter((l) => l !== listener);
  }

  /** Simulate the worker posting a message back. */
  simulateMessage(data: KokoroWorkerResponse) {
    const event = new MessageEvent("message", { data });
    this.messageListeners.forEach((l) => l(event));
  }

  /** Simulate a worker error. */
  simulateError() {
    this.errorListeners.forEach((l) => l());
  }

  static instances: MockWorker[] = [];
  static reset() {
    MockWorker.instances = [];
  }
  static get latest() {
    return MockWorker.instances[MockWorker.instances.length - 1];
  }
}

vi.stubGlobal("Worker", MockWorker);

import { KokoroLocalTTSProvider } from "../../../../src/ai/voice/adapters/kokoro-local-tts.js";

describe("KokoroLocalTTSProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWorker.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct id, name, and needsApiKey", () => {
    const provider = new KokoroLocalTTSProvider();
    expect(provider.id).toBe("kokoro-local");
    expect(provider.name).toBe("Kokoro (Local)");
    expect(provider.needsApiKey).toBe(false);
  });

  it("uses default model ID", () => {
    const provider = new KokoroLocalTTSProvider();
    expect(provider.modelId).toBe("onnx-community/Kokoro-82M-v1.0-ONNX");
  });

  it("uses custom model ID when provided", () => {
    const provider = new KokoroLocalTTSProvider({ modelId: "custom/tts" });
    expect(provider.modelId).toBe("custom/tts");
  });

  it("starts with idle status", () => {
    const provider = new KokoroLocalTTSProvider();
    expect(provider.status).toBe("idle");
    expect(provider.progress).toBe(0);
  });

  it("returns 21 voices", async () => {
    const provider = new KokoroLocalTTSProvider();
    const voices = await provider.getVoices();
    expect(voices.length).toBe(21);
    expect(voices[0]).toEqual({ id: "af_heart", name: "Heart (Female)" });
    // Check we have both genders and accents
    expect(voices.some((v) => v.id.startsWith("am_"))).toBe(true);
    expect(voices.some((v) => v.id.startsWith("bf_"))).toBe(true);
    expect(voices.some((v) => v.id.startsWith("bm_"))).toBe(true);
  });

  it("creates a Worker and loads the model", async () => {
    const onStatusChange = vi.fn();
    const provider = new KokoroLocalTTSProvider({ onStatusChange });

    const preloadPromise = provider.preload();

    // Worker should have been created
    expect(MockWorker.instances.length).toBe(1);
    const worker = MockWorker.latest;

    // Should have posted a load message
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "load",
      modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    });

    expect(onStatusChange).toHaveBeenCalledWith("loading", 0);

    // Simulate progress
    worker.simulateMessage({ type: "load-progress", progress: 50 });
    expect(onStatusChange).toHaveBeenCalledWith("loading", 50);

    // Simulate load complete
    worker.simulateMessage({ type: "load-complete" });
    await preloadPromise;

    expect(provider.status).toBe("ready");
    expect(onStatusChange).toHaveBeenCalledWith("ready", 100);
  });

  it("synthesizes text via the worker", async () => {
    const provider = new KokoroLocalTTSProvider();

    // Load model first
    const preloadPromise = provider.preload();
    MockWorker.latest.simulateMessage({ type: "load-complete" });
    await preloadPromise;

    const worker = MockWorker.latest;

    // Start synthesis (async — needs microtask flush for postMessage to fire)
    const synthPromise = provider.synthesize("Hello world");
    await Promise.resolve();

    // Worker should have received synthesize message
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "synthesize",
        text: "Hello world",
        voice: "af_heart",
      }),
    );

    // Get the synth ID from the postMessage call
    const synthCall = worker.postMessage.mock.calls.find((c: any[]) => c[0].type === "synthesize");
    const synthId = synthCall![0].id;

    // Simulate worker response with WAV buffer
    const wavBuffer = new ArrayBuffer(52);
    worker.simulateMessage({
      type: "synthesize-complete",
      id: synthId,
      buffer: wavBuffer,
    });

    const result = await synthPromise;
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(52);
  });

  it("uses specified voice", async () => {
    const provider = new KokoroLocalTTSProvider();

    const preloadPromise = provider.preload();
    MockWorker.latest.simulateMessage({ type: "load-complete" });
    await preloadPromise;

    const synthPromise = provider.synthesize("Test", { voice: "am_adam" });
    await Promise.resolve();

    const worker = MockWorker.latest;
    const synthCall = worker.postMessage.mock.calls.find((c: any[]) => c[0].type === "synthesize");
    expect(synthCall![0].voice).toBe("am_adam");

    // Complete the synthesis to avoid dangling promise
    worker.simulateMessage({
      type: "synthesize-complete",
      id: synthCall![0].id,
      buffer: new ArrayBuffer(0),
    });
    await synthPromise;
  });

  it("reports progress during model loading", async () => {
    const onStatusChange = vi.fn();
    const provider = new KokoroLocalTTSProvider({ onStatusChange });

    const preloadPromise = provider.preload();
    const worker = MockWorker.latest;

    worker.simulateMessage({ type: "load-progress", progress: 30 });
    worker.simulateMessage({ type: "load-progress", progress: 60 });
    worker.simulateMessage({ type: "load-progress", progress: 100 });
    worker.simulateMessage({ type: "load-complete" });

    await preloadPromise;

    expect(onStatusChange).toHaveBeenCalledWith("loading", 30);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 60);
    expect(onStatusChange).toHaveBeenCalledWith("loading", 100);
  });

  it("sets error status when model loading fails", async () => {
    const onStatusChange = vi.fn();
    const provider = new KokoroLocalTTSProvider({ onStatusChange });

    const preloadPromise = provider.preload();
    const worker = MockWorker.latest;

    worker.simulateMessage({ type: "load-error", error: "Download failed" });

    await expect(preloadPromise).rejects.toThrow("Download failed");

    expect(provider.status).toBe("error");
    expect(onStatusChange).toHaveBeenCalledWith("error", 0);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("reuses worker on subsequent calls", async () => {
    const provider = new KokoroLocalTTSProvider();

    const preloadPromise = provider.preload();
    MockWorker.latest.simulateMessage({ type: "load-complete" });
    await preloadPromise;

    // Start two synthesis calls
    const synth1 = provider.synthesize("First");
    const synth2 = provider.synthesize("Second");
    await Promise.resolve();

    expect(MockWorker.instances.length).toBe(1);

    // Complete both
    const worker = MockWorker.latest;
    const calls = worker.postMessage.mock.calls.filter((c: any[]) => c[0].type === "synthesize");
    expect(calls.length).toBe(2);

    worker.simulateMessage({
      type: "synthesize-complete",
      id: calls[0][0].id,
      buffer: new ArrayBuffer(10),
    });
    worker.simulateMessage({
      type: "synthesize-complete",
      id: calls[1][0].id,
      buffer: new ArrayBuffer(20),
    });

    const [r1, r2] = await Promise.all([synth1, synth2]);
    expect(r1.byteLength).toBe(10);
    expect(r2.byteLength).toBe(20);
  });

  it("rejects pending syntheses on worker crash", async () => {
    const onStatusChange = vi.fn();
    const provider = new KokoroLocalTTSProvider({ onStatusChange });

    const preloadPromise = provider.preload();
    MockWorker.latest.simulateMessage({ type: "load-complete" });
    await preloadPromise;

    const synthPromise = provider.synthesize("Will crash");
    await Promise.resolve();
    const worker = MockWorker.latest;

    // Simulate worker crash
    worker.simulateError();

    await expect(synthPromise).rejects.toThrow("Worker crashed");
    expect(provider.status).toBe("error");
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("handles synthesis error from worker", async () => {
    const provider = new KokoroLocalTTSProvider();

    const preloadPromise = provider.preload();
    MockWorker.latest.simulateMessage({ type: "load-complete" });
    await preloadPromise;

    const synthPromise = provider.synthesize("Error text");
    await Promise.resolve();
    const worker = MockWorker.latest;
    const synthCall = worker.postMessage.mock.calls.find((c: any[]) => c[0].type === "synthesize");

    worker.simulateMessage({
      type: "synthesize-error",
      id: synthCall![0].id,
      error: "Generation failed",
    });

    await expect(synthPromise).rejects.toThrow("Generation failed");
  });
});
