import { describe, expect, it } from "vitest";
import {
  AI_ASSISTANT_TEXT_BYTES_MAX,
  AI_DIAGNOSTIC_STRING_BYTES_MAX,
  AI_SSE_MAX_FRAME_BYTES,
  AI_TOOL_ARGUMENTS_BYTES_MAX,
  AiSseError,
} from "./types";
import {
  AiRunSseReducer,
  AiSseDecoder,
  consumeAiRunSseStream,
  createVisibleTextFrameBatcher,
} from "./sse";

const RUN = "11111111-1111-4111-8111-111111111111";

function envelope(
  sequence: number,
  type: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    run_id: RUN,
    generation: 1,
    sequence,
    type,
    payload,
    ...overrides,
  });
}

function sseData(data: string, id?: string): string {
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}data: ${data}\n\n`;
}

function pushString(decoder: AiSseDecoder, text: string): ReturnType<AiSseDecoder["push"]> {
  return decoder.push(new TextEncoder().encode(text));
}

describe("AiSseDecoder", () => {
  it("decodes fragmented UTF-8 and multi-line CRLF data frames", () => {
    const decoder = new AiSseDecoder();
    // "你好" = e4 bd a0 e5 a5 bd — split across chunks inside the multibyte sequence.
    const json = envelope(1, "text_delta", { text: "你好" });
    const wire = `data: ${json}\r\n\r\n`;
    const bytes = new TextEncoder().encode(wire);
    const nihao = new TextEncoder().encode("你好");
    const splitAt = bytes.indexOf(nihao[0]!) + 1; // after first byte of 你

    const framesA = decoder.push(bytes.slice(0, splitAt));
    const framesB = decoder.push(bytes.slice(splitAt));
    const frames = [...framesA, ...framesB, ...decoder.finish()];

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.data)).toMatchObject({
      type: "text_delta",
      payload: { text: "你好" },
    });

    // Multi-line data: over CRLF — SSE joins data lines with LF.
    const decoder2 = new AiSseDecoder();
    const multi = `data: hello\r\ndata: world\r\n\r\n`;
    const multiFrames = [...pushString(decoder2, multi), ...decoder2.finish()];
    expect(multiFrames).toHaveLength(1);
    expect(multiFrames[0]!.data).toBe("hello\nworld");
  });

  it("joins multi-line data: fields with LF and ignores keepalive comments", () => {
    const decoder = new AiSseDecoder();
    const frames = [
      ...pushString(decoder, `:keepalive\ndata: {"a":1}\ndata: {"b":2}\n\n`),
      ...decoder.finish(),
    ];
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('{"a":1}\n{"b":2}');
  });

  it("rejects oversized frames and undecoded buffers", () => {
    const decoder = new AiSseDecoder();
    const huge = "x".repeat(AI_SSE_MAX_FRAME_BYTES);
    try {
      pushString(decoder, `data: ${huge}`);
      expect.fail("expected frame bound error");
    } catch (error) {
      expect(error).toMatchObject({ code: "frame_bound" });
    }

    const decoder2 = new AiSseDecoder();
    // No blank line — unterminated line still counts toward the frame bound.
    try {
      pushString(decoder2, `data: ${"y".repeat(AI_SSE_MAX_FRAME_BYTES)}`);
      expect.fail("expected frame bound error");
    } catch (error) {
      expect(error).toMatchObject({ code: "frame_bound" });
    }
  });
});

describe("AiRunSseReducer", () => {
  function reduceAll(chunks: string[]): AiRunSseReducer {
    const decoder = new AiSseDecoder();
    const reducer = new AiRunSseReducer();
    for (const chunk of chunks) {
      for (const frame of pushString(decoder, chunk)) {
        reducer.pushFrame(frame);
      }
    }
    for (const frame of decoder.finish()) {
      reducer.pushFrame(frame);
    }
    return reducer;
  }

  it("binds identity, accumulates text, usage, tools, and one terminal", () => {
    const reducer = reduceAll([
      sseData(
        envelope(1, "run_started", {
          context: {
            truncated: false,
            utf8_bytes: 1,
            approximate_tokens: 1,
            focused_task_included: false,
            history_messages_included: 0,
            history_rows_loaded: 0,
            memories_considered: 0,
            memories_included: 0,
          },
        }),
      ),
      sseData(envelope(2, "text_delta", { text: "Hel" })),
      sseData(envelope(3, "text_delta", { text: "lo" })),
      sseData(envelope(4, "reasoning_status", { status: "thinking" })),
      sseData(envelope(5, "usage", { input_tokens: 3, output_tokens: 2 })),
      sseData(
        envelope(6, "tool_proposed", {
          approval_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tool: "create_task",
          arguments: { title: "x" },
          action_hash: "a".repeat(64),
          expires_at: "2026-08-01T00:00:00Z",
        }),
      ),
      sseData(
        envelope(7, "tool_approved", { approval_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      ),
      sseData(
        envelope(8, "tool_result", {
          tool: "create_task",
          outcome: "success",
          data: { ok: true },
          truncated: false,
        }),
      ),
      sseData(
        envelope(9, "run_completed", {
          assistant_message_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      ),
    ]);

    const state = reducer.state;
    expect(state.runId).toBe(RUN);
    expect(state.generation).toBe(1);
    expect(state.visibleText).toBe("Hello");
    expect(state.reasoningStatus).toBe("thinking");
    expect(state.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]?.approvalId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(state.decisions[0]?.decision).toBe("approved");
    expect(state.results[0]?.outcome).toBe("success");
    expect(state.terminal).toEqual({
      kind: "completed",
      assistantMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });

  it("rejects version, identity, sequence, and unknown event types", () => {
    const reducer = new AiRunSseReducer();
    const badVersion = {
      event: null,
      id: null,
      data: envelope(1, "run_started", { replay: true }, { version: 2 }),
      frameBytes: 1,
    };
    expect(() => reducer.pushFrame(badVersion)).toThrowError(
      expect.objectContaining({ code: "version" }),
    );

    const ok = {
      event: null,
      id: "1",
      data: envelope(1, "run_started", { replay: true }),
      frameBytes: 1,
    };
    reducer.pushFrame(ok);

    expect(() =>
      reducer.pushFrame({
        event: null,
        id: "2",
        data: envelope(
          2,
          "text_delta",
          { text: "x" },
          { run_id: "22222222-2222-4222-8222-222222222222" },
        ),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "identity" }));

    const reducer2 = new AiRunSseReducer();
    reducer2.pushFrame(ok);
    expect(() =>
      reducer2.pushFrame({
        event: null,
        id: "1",
        data: envelope(1, "text_delta", { text: "x" }),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "sequence" }));

    const reducer3 = new AiRunSseReducer();
    expect(() =>
      reducer3.pushFrame({
        event: null,
        id: null,
        data: envelope(1, "provider_delta", { text: "x" }),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "event_type" }));
  });

  it("rejects vendor fields and malformed JSON", () => {
    const reducer = new AiRunSseReducer();
    expect(() =>
      reducer.pushFrame({
        event: null,
        id: null,
        data: envelope(1, "text_delta", { text: "x", choices: [] }),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "vendor_field" }));

    expect(() =>
      reducer.pushFrame({
        event: null,
        id: null,
        data: "{not-json",
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "malformed_json" }));
  });

  it("enforces text, tool argument, and diagnostic bounds", () => {
    const reducer = new AiRunSseReducer();
    reducer.pushFrame({
      event: null,
      id: null,
      data: envelope(1, "run_started", { replay: true }),
      frameBytes: 1,
    });

    const big = "x".repeat(AI_ASSISTANT_TEXT_BYTES_MAX);
    reducer.pushFrame({
      event: null,
      id: null,
      data: envelope(2, "text_delta", { text: big }),
      frameBytes: 1,
    });
    expect(() =>
      reducer.pushFrame({
        event: null,
        id: null,
        data: envelope(3, "text_delta", { text: "y" }),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "text_bound" }));

    const reducer2 = new AiRunSseReducer();
    reducer2.pushFrame({
      event: null,
      id: null,
      data: envelope(1, "run_started", { replay: true }),
      frameBytes: 1,
    });
    expect(() =>
      reducer2.pushFrame({
        event: null,
        id: null,
        data: envelope(2, "tool_proposed", {
          approval_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tool: "create_task",
          arguments: { blob: "z".repeat(AI_TOOL_ARGUMENTS_BYTES_MAX) },
          action_hash: "a".repeat(64),
          expires_at: "2026-08-01T00:00:00Z",
        }),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "tool_bound" }));

    const reducer3 = new AiRunSseReducer();
    expect(() =>
      reducer3.pushFrame({
        event: null,
        id: null,
        data: envelope(1, "reasoning_status", {
          status: "s".repeat(AI_DIAGNOSTIC_STRING_BYTES_MAX + 1),
        }),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "diagnostic_bound" }));
  });

  it("rejects duplicate terminals and marks EOF without terminal as interrupted", () => {
    const reducer = new AiRunSseReducer();
    reducer.pushFrame({
      event: null,
      id: null,
      data: envelope(1, "run_started", { replay: true }),
      frameBytes: 1,
    });
    reducer.pushFrame({
      event: null,
      id: null,
      data: envelope(2, "run_completed", {
        assistant_message_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      frameBytes: 1,
    });
    expect(() =>
      reducer.pushFrame({
        event: null,
        id: null,
        data: envelope(3, "run_failed", { error: "ai_run_failed" }),
        frameBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate_terminal" }));

    const open = new AiRunSseReducer();
    open.pushFrame({
      event: null,
      id: null,
      data: envelope(1, "text_delta", { text: "partial" }),
      frameBytes: 1,
    });
    const finished = open.finish();
    expect(finished.terminal).toMatchObject({
      kind: "interrupted",
      reason: "eof_without_terminal",
    });
  });

  it("pullVisibleText advances only when text changes", () => {
    const reducer = new AiRunSseReducer();
    expect(reducer.pullVisibleText()).toBeNull();
    reducer.pushFrame({
      event: null,
      id: null,
      data: envelope(1, "text_delta", { text: "a" }),
      frameBytes: 1,
    });
    expect(reducer.pullVisibleText()).toEqual({ text: "a", revision: 1 });
    expect(reducer.pullVisibleText()).toBeNull();
    reducer.pushFrame({
      event: null,
      id: null,
      data: envelope(2, "reasoning_status", { status: "ok" }),
      frameBytes: 1,
    });
    expect(reducer.pullVisibleText()).toBeNull();
  });
});

describe("createVisibleTextFrameBatcher", () => {
  it("coalesces notifications to one flush per animation frame", () => {
    const flushes: string[] = [];
    const scheduled: Array<() => void> = [];
    const batcher = createVisibleTextFrameBatcher(
      (text) => {
        flushes.push(text);
      },
      (cb) => {
        scheduled.push(cb);
        return scheduled.length;
      },
      () => {
        scheduled.length = 0;
      },
    );

    const base = {
      runId: RUN,
      generation: 1,
      lastSequence: 1,
      lastEventId: "1",
      visibleText: "a",
      reasoningStatus: null,
      usage: null,
      context: null,
      replay: false,
      proposals: [],
      decisions: [],
      results: [],
      terminal: null,
      textRevision: 1,
    };
    batcher.notify(base);
    batcher.notify({ ...base, visibleText: "ab", textRevision: 2 });
    batcher.notify({ ...base, visibleText: "abc", textRevision: 3 });
    expect(flushes).toEqual([]);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(flushes).toEqual(["abc"]);
    batcher.dispose();
  });
});

describe("consumeAiRunSseStream", () => {
  it("consumes a deterministic stream body to a terminal state", async () => {
    const wire =
      sseData(envelope(1, "run_started", { replay: true })) +
      sseData(envelope(2, "text_delta", { text: "Hi" })) +
      sseData(
        envelope(3, "run_completed", {
          assistant_message_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    });

    const states: number[] = [];
    const state = await consumeAiRunSseStream(stream, {
      handlers: {
        onState: (s) => states.push(s.lastSequence ?? 0),
      },
    });
    expect(state.visibleText).toBe("Hi");
    expect(state.terminal?.kind).toBe("completed");
    expect(states.length).toBeGreaterThan(0);
  });

  it("treats abort as interrupted without auto-replay", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(sseData(envelope(1, "text_delta", { text: "x" }))),
        );
        controller.abort();
        // leave open
      },
    });

    // Force the loop to observe abort after first read by cancelling via signal.
    const result = await consumeAiRunSseStream(stream, { signal: controller.signal });
    expect(result.terminal).toMatchObject({ kind: "interrupted", reason: "aborted" });
  });
});

describe("AiSseError secrecy", () => {
  it("does not embed bearer tokens in error messages", () => {
    const error = new AiSseError("protocol", "stream failed");
    expect(error.message).not.toMatch(/Bearer/i);
    expect(String(error)).not.toMatch(/sk-/);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(
      /secret|Bearer\s+\S+/i,
    );
  });
});
