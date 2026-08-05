import { describe, expect, it, vi } from "vitest";
import type { LocalVoiceRequest, LocalVoiceResponse } from "../protocol.ts";
import { LocalVoiceClientError } from "../protocol.ts";
import { installLocalVoiceWorker } from "./worker-runtime.ts";

function mockScope() {
  const posts: Array<{ data: LocalVoiceResponse; transfer?: Transferable[] }> = [];
  const scope = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage(data: LocalVoiceResponse, transfer?: Transferable[]) {
      posts.push({ data, transfer });
    },
  };
  return {
    scope: scope as unknown as DedicatedWorkerGlobalScope & { onmessage: typeof scope.onmessage },
    posts,
  };
}

describe("installLocalVoiceWorker", () => {
  it("handles ping/load/transcribe/dispose and transfers audio buffers", async () => {
    const { scope, posts } = mockScope();
    const dispose = vi.fn(async () => undefined);
    const pcmOut = new ArrayBuffer(8);

    installLocalVoiceWorker(scope, {
      async load() {
        return {
          packageId: "whisper-tiny.en-q4",
          modelId: "repo",
          revision: "rev",
        };
      },
      async transcribe() {
        return "hello";
      },
      async synthesize() {
        return {
          format: "pcm-f32",
          pcm: pcmOut,
          sampleRate: 24_000,
          channels: 1,
        };
      },
      dispose,
    });

    const deliver = (data: LocalVoiceRequest) => {
      scope.onmessage?.({ data } as MessageEvent<unknown>);
    };

    deliver({ type: "ping", requestId: "1", generation: 0 });
    await vi.waitFor(() => expect(posts.at(-1)?.data.type).toBe("pong"));

    deliver({ type: "load", requestId: "2", generation: 1 });
    await vi.waitFor(() => expect(posts.at(-1)?.data.type).toBe("load-complete"));

    deliver({
      type: "transcribe",
      requestId: "3",
      generation: 1,
      pcm: new Float32Array([0.1]).buffer,
      sampleRate: 16_000,
    });
    await vi.waitFor(() => expect(posts.at(-1)?.data.type).toBe("transcript"));
    expect(posts.at(-1)?.data).toMatchObject({ text: "hello" });

    deliver({ type: "synthesize", requestId: "4", generation: 1, text: "hi" });
    await vi.waitFor(() => expect(posts.at(-1)?.data.type).toBe("audio"));
    expect(posts.at(-1)?.transfer).toEqual([pcmOut]);

    deliver({ type: "dispose", requestId: "5", generation: 2 });
    await vi.waitFor(() => expect(posts.at(-1)?.data.type).toBe("disposed"));
    expect(dispose).toHaveBeenCalledOnce();

    deliver({ type: "ping", requestId: "6", generation: 3 });
    await vi.waitFor(() =>
      expect(posts.at(-1)?.data).toMatchObject({ type: "error", code: "disposed" }),
    );
  });

  it("maps engine errors to stable codes and rejects unknown messages", async () => {
    const { scope, posts } = mockScope();
    installLocalVoiceWorker(scope, {
      async load() {
        throw new LocalVoiceClientError("cache_miss");
      },
      async dispose() {},
    });

    scope.onmessage?.({
      data: { type: "load", requestId: "a", generation: 1 },
    } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(posts.at(-1)?.data).toMatchObject({ type: "error", code: "cache_miss" }),
    );

    scope.onmessage?.({
      data: { type: "nope", requestId: "b", generation: 1 },
    } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(posts.at(-1)?.data).toMatchObject({ type: "error", code: "invalid_message" }),
    );
  });
});
