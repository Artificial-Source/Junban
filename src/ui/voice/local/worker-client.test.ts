import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ,
  type LocalVoiceRequest,
  type LocalVoiceResponse,
} from "./protocol.ts";
import { LocalWhisperClient, LocalKokoroClient } from "./worker-client.ts";

type Handler = (event: MessageEvent<unknown>) => void;

class MockWorker {
  static instances: MockWorker[] = [];
  listeners = new Map<string, Set<Handler>>();
  terminated = false;
  posts: Array<{ data: LocalVoiceRequest; transfer?: Transferable[] }> = [];
  auto?: (req: LocalVoiceRequest, worker: MockWorker) => void;

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: Handler): void {
    this.listeners.get(type)?.delete(handler);
  }

  postMessage(data: LocalVoiceRequest, transfer?: Transferable[]): void {
    if (this.terminated) throw new Error("terminated");
    this.posts.push({ data, transfer });
    this.auto?.(data, this);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: LocalVoiceResponse): void {
    const event = { data } as MessageEvent<unknown>;
    for (const handler of this.listeners.get("message") ?? []) {
      handler(event);
    }
  }
}

describe("LocalVoiceWorkerClient", () => {
  afterEach(() => {
    MockWorker.instances = [];
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("creates a worker only on load and supports transcribe + generation fencing", async () => {
    const client = new LocalWhisperClient({
      createWorker: () => new MockWorker() as unknown as Worker,
    });
    expect(MockWorker.instances).toHaveLength(0);

    const workerPromise = client.load();
    await flush();
    expect(MockWorker.instances).toHaveLength(1);
    const worker = MockWorker.instances[0]!;
    const loadReq = worker.posts[0]!.data;
    expect(loadReq.type).toBe("load");
    worker.emit({
      type: "load-complete",
      requestId: loadReq.requestId,
      generation: loadReq.generation,
      packageId: "whisper-tiny.en-q4",
      modelId: "onnx-community/whisper-tiny.en",
      revision: "rev",
    });
    const info = await workerPromise;
    expect(info.packageId).toBe("whisper-tiny.en-q4");

    const samples = new Float32Array([0.1, 0.2]);
    const gen = info.generation;
    const txPromise = client.transcribe(samples, gen);
    await flush();
    const txReq = worker.posts.at(-1)!.data;
    expect(txReq.type).toBe("transcribe");
    if (txReq.type === "transcribe") {
      expect(txReq.sampleRate).toBe(LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ);
      expect(txReq.pcm.byteLength).toBe(8);
    }
    worker.emit({
      type: "transcript",
      requestId: txReq.requestId,
      generation: gen,
      text: "hello",
    });
    await expect(txPromise).resolves.toEqual({ text: "hello", generation: gen });

    // Stale generation is rejected on the host before post.
    await expect(client.transcribe(samples, gen - 1)).rejects.toMatchObject({ code: "aborted" });
  });

  it("discards late responses after dispose/terminate and is idempotent", async () => {
    const client = new LocalWhisperClient({
      createWorker: () => new MockWorker() as unknown as Worker,
    });

    const loadP = client.load();
    await flush();
    const worker = MockWorker.instances[0]!;
    const loadReq = worker.posts[0]!.data;
    worker.emit({
      type: "load-complete",
      requestId: loadReq.requestId,
      generation: loadReq.generation,
      packageId: "w",
      modelId: "m",
      revision: "r",
    });
    const info = await loadP;

    const txP = client.transcribe(new Float32Array([1, 2]), info.generation);
    await flush();
    const txReq = worker.posts.at(-1)!.data;

    const disposeP = client.dispose();
    await flush();
    const disposeReq = worker.posts.find((p) => p.data.type === "dispose")!.data;
    worker.emit({
      type: "disposed",
      requestId: disposeReq.requestId,
      generation: disposeReq.generation,
    });
    await disposeP;
    expect(worker.terminated).toBe(true);

    // Late transcript for old request must not resolve the aborted waiter.
    worker.emit({
      type: "transcript",
      requestId: txReq.requestId,
      generation: info.generation,
      text: "late",
    });
    await expect(txP).rejects.toMatchObject({ code: "disposed" });

    await client.dispose();
    await client.dispose();
  });

  it("honors abort and timeout", async () => {
    const client = new LocalKokoroClient({
      createWorker: () => new MockWorker() as unknown as Worker,
      loadTimeoutMs: 30,
      inferTimeoutMs: 30,
    });

    await expect(client.load()).rejects.toMatchObject({ code: "timeout" });
    await client.dispose();

    // Fresh client for abort path
    const client2 = new LocalKokoroClient({
      createWorker: () => {
        const w = new MockWorker();
        w.auto = (req, worker) => {
          if (req.type === "load") {
            queueMicrotask(() =>
              worker.emit({
                type: "load-complete",
                requestId: req.requestId,
                generation: req.generation,
                packageId: "k",
                modelId: "m",
                revision: "r",
                voiceId: "af_heart",
              }),
            );
          } else if (req.type === "dispose") {
            queueMicrotask(() =>
              worker.emit({
                type: "disposed",
                requestId: req.requestId,
                generation: req.generation,
              }),
            );
          }
        };
        return w as unknown as Worker;
      },
    });
    const info = await client2.load();
    const ac = new AbortController();
    const synthP = client2.synthesize("hi", info.generation, ac.signal);
    await flush();
    ac.abort();
    await expect(synthP).rejects.toMatchObject({ code: "aborted" });
    await client2.dispose();
  });

  it("rejects invalid audio before posting", async () => {
    const client = new LocalWhisperClient({
      createWorker: () => {
        const w = new MockWorker();
        w.auto = (req, worker) => {
          if (req.type === "load") {
            worker.emit({
              type: "load-complete",
              requestId: req.requestId,
              generation: req.generation,
              packageId: "w",
              modelId: "m",
              revision: "r",
            });
          }
        };
        return w as unknown as Worker;
      },
    });
    const info = await client.load();
    await expect(
      client.transcribe(new Float32Array([Number.NaN]), info.generation),
    ).rejects.toMatchObject({ code: "invalid_audio" });
  });
});
