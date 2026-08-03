/**
 * SSE-driven conversation lifecycle with deterministic fake transport.
 * @vitest-environment jsdom
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiConversation, type UseAiConversationResult } from "./useAiConversation";
import type { ConversationTransport } from "./conversation-transport";
import type { AiRunStreamState } from "./types";
import { createInitialAiRunStreamState } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_MSG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASST_MSG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPROVAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function sessionDto(id = SESSION_ID) {
  return {
    id,
    title: "New chat",
    message_count: 0,
    content_bytes: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message_at: null,
    status: "active" as const,
  };
}

function messageDto(
  over: Partial<{
    id: string;
    role: "user" | "assistant";
    text: string;
    status: "completed" | "failed" | "cancelled";
    sequence: number;
    focused_task_id: string | null;
  }> = {},
) {
  return {
    id: over.id ?? USER_MSG,
    session_id: SESSION_ID,
    turn_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    role: over.role ?? "user",
    status: over.status ?? "completed",
    sequence: over.sequence ?? 1,
    content_bytes: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    content: {
      text: over.text ?? "hi",
      focused_task_id: over.focused_task_id ?? null,
    },
  };
}

function approvalResponse(id: string, actionHash: string, status: string) {
  return {
    approval: {
      id,
      session_id: SESSION_ID,
      turn_id: "t",
      run_id: RUN_ID,
      generation: 1,
      tool_name: "create_task",
      arguments: {},
      action_hash: actionHash,
      status,
      expires_at: "2026-01-01T00:05:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    message: messageDto({ id: ASST_MSG, role: "assistant", text: "hello", sequence: 2 }),
    run: {
      id: RUN_ID,
      session_id: SESSION_ID,
      turn_id: "t",
      generation: 1,
      status: "completed",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  };
}

function makeTransport(overrides: Partial<ConversationTransport> = {}): {
  transport: ConversationTransport;
  ops: string[];
  streamStates: AiRunStreamState[];
} {
  const ops: string[] = [];
  const streamStates: AiRunStreamState[] = [];
  let messages = [] as ReturnType<typeof messageDto>[];

  const transport = {
    listSessions: vi.fn(async () => ({ sessions: [], next_cursor: null })),
    createSession: vi.fn(async (_body: unknown, options?: { operationId?: string }) => {
      ops.push(`createSession:${options?.operationId ?? "?"}`);
      return {
        session: sessionDto(),
        event: {
          id: "1",
          revision: 1,
          event_type: "ai.session.changed",
          occurred_at: "2026-01-01T00:00:00Z",
          operation_id: options?.operationId ?? "op",
          resync: { kind: "none" },
          affected: {},
        },
      };
    }),
    updateSession: vi.fn(async () => {
      throw new Error("unused");
    }),
    deleteSession: vi.fn(async () => {
      throw new Error("unused");
    }),
    clearSession: vi.fn(async () => {
      throw new Error("unused");
    }),
    listMessages: vi.fn(async () => ({ messages: [...messages] })),
    createResponse: vi.fn(
      async (
        _sid: string,
        body: { message: string; focused_task_id?: string | null },
        options?: {
          operationId?: string;
          handlers?: { onState?: (s: AiRunStreamState) => void };
          signal?: AbortSignal;
        },
      ) => {
        ops.push(`createResponse:${options?.operationId ?? "?"}:${body.message}`);
        const state = createInitialAiRunStreamState();
        state.runId = RUN_ID;
        state.generation = 1;
        state.lastSequence = 0;
        state.visibleText = "hello";
        state.textRevision = 1;
        state.terminal = { kind: "completed", assistantMessageId: ASST_MSG };
        options?.handlers?.onState?.(state);
        streamStates.push(state);
        messages = [
          messageDto({
            id: USER_MSG,
            role: "user",
            text: body.message,
            sequence: 1,
            focused_task_id: body.focused_task_id ?? null,
          }),
          messageDto({
            id: ASST_MSG,
            role: "assistant",
            text: "hello",
            sequence: 2,
          }),
        ];
        return { operationId: options?.operationId ?? "op", state };
      },
    ),
    createDailyBriefing: vi.fn(async () => {
      throw new Error("unused");
    }),
    editResponse: vi.fn(
      async (
        _s: string,
        _m: string,
        body: { message: string },
        options?: {
          operationId?: string;
          handlers?: { onState?: (s: AiRunStreamState) => void };
        },
      ) => {
        ops.push(`edit:${options?.operationId ?? "?"}:${body.message}`);
        const state = createInitialAiRunStreamState();
        state.runId = RUN_ID;
        state.terminal = { kind: "completed", assistantMessageId: ASST_MSG };
        options?.handlers?.onState?.(state);
        return { operationId: options?.operationId ?? "op", state };
      },
    ),
    retryResponse: vi.fn(
      async (
        _s: string,
        _m: string,
        options?: {
          operationId?: string;
          handlers?: { onState?: (s: AiRunStreamState) => void };
        },
      ) => {
        ops.push(`retry:${options?.operationId ?? "?"}`);
        const state = createInitialAiRunStreamState();
        state.runId = RUN_ID;
        state.terminal = { kind: "completed", assistantMessageId: ASST_MSG };
        options?.handlers?.onState?.(state);
        return { operationId: options?.operationId ?? "op", state };
      },
    ),
    regenerateResponse: vi.fn(
      async (
        _s: string,
        _m: string,
        options?: {
          operationId?: string;
          handlers?: { onState?: (s: AiRunStreamState) => void };
        },
      ) => {
        ops.push(`regen:${options?.operationId ?? "?"}`);
        const state = createInitialAiRunStreamState();
        state.runId = RUN_ID;
        state.terminal = { kind: "completed", assistantMessageId: ASST_MSG };
        options?.handlers?.onState?.(state);
        return { operationId: options?.operationId ?? "op", state };
      },
    ),
    cancelRun: vi.fn(async (runId: string) => {
      ops.push(`cancel:${runId}`);
      return { run_id: runId, status: "cancelled" };
    }),
    getApproval: vi.fn(async (id: string) => approvalResponse(id, "c".repeat(64), "approved")),
    approveApproval: vi.fn(
      async (id: string, body: { action_hash: string }, options?: { operationId?: string }) => {
        ops.push(`approve:${id}:${body.action_hash}:${options?.operationId ?? "?"}`);
        return approvalResponse(id, body.action_hash, "approved");
      },
    ),
    rejectApproval: vi.fn(
      async (id: string, body: { action_hash: string }, options?: { operationId?: string }) => {
        ops.push(`reject:${id}:${body.action_hash}:${options?.operationId ?? "?"}`);
        return approvalResponse(id, body.action_hash, "rejected");
      },
    ),
    ...overrides,
  } as unknown as ConversationTransport;

  return { transport, ops, streamStates };
}

function renderConversation(
  transport: ConversationTransport,
  focusedTaskId?: string | null,
): {
  getResult: () => UseAiConversationResult;
  unmount: () => void;
} {
  let latest: UseAiConversationResult | null = null;
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);

  function Probe() {
    const result = useAiConversation({ transport, focusedTaskId, enabled: true });
    useEffect(() => {
      latest = result;
    });
    latest = result;
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });

  return {
    getResult: () => {
      if (!latest) throw new Error("no result");
      return latest;
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("useAiConversation", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    // nothing
  });

  it("creates a session only on first send and reloads authoritative messages", async () => {
    const { transport, ops } = makeTransport();
    const { getResult, unmount } = renderConversation(transport);

    await act(async () => {
      await getResult().sendMessage("Hello there");
    });

    expect(ops.some((o) => o.startsWith("createSession:"))).toBe(true);
    expect(ops.some((o) => o.includes("createResponse:"))).toBe(true);
    expect(getResult().activeSessionId).toBe(SESSION_ID);
    expect(getResult().messages.some((m) => m.role === "user" && m.text === "Hello there")).toBe(
      true,
    );
    expect(getResult().messages.some((m) => m.role === "assistant" && m.text === "hello")).toBe(
      true,
    );
    expect(getResult().isStreaming).toBe(false);
    // Second send does not create another session.
    const createCount = ops.filter((o) => o.startsWith("createSession:")).length;
    await act(async () => {
      await getResult().sendMessage("Again");
    });
    expect(ops.filter((o) => o.startsWith("createSession:")).length).toBe(createCount);

    unmount();
  });

  it("includes focused_task_id on create response", async () => {
    const focused = "01234567-0123-4123-8123-0123456789ab";
    const { transport } = makeTransport();
    const { getResult, unmount } = renderConversation(transport, focused);

    await act(async () => {
      await getResult().sendMessage("About this task");
    });

    expect(transport.createResponse).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        message: "About this task",
        focused_task_id: focused,
      }),
      expect.any(Object),
    );
    unmount();
  });

  it("retains one operation id per logical action across the stream call", async () => {
    const { transport, ops } = makeTransport();
    const { getResult, unmount } = renderConversation(transport);

    await act(async () => {
      await getResult().sendMessage("One");
    });
    const sendOps = ops.filter((o) => o.startsWith("createResponse:"));
    expect(sendOps).toHaveLength(1);
    const opId = sendOps[0]!.split(":")[1];
    expect(opId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    unmount();
  });

  it("stop cancels durable run then aborts local stream", async () => {
    let resolveStream: ((value: unknown) => void) | null = null;
    const { transport, ops } = makeTransport({
      createResponse: vi.fn(async (_s, _b, options) => {
        const state = createInitialAiRunStreamState();
        state.runId = RUN_ID;
        state.generation = 1;
        options?.handlers?.onState?.(state);
        await new Promise((resolve) => {
          resolveStream = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        const terminal = createInitialAiRunStreamState();
        terminal.runId = RUN_ID;
        terminal.terminal = {
          kind: "interrupted",
          reason: "aborted",
          message: "aborted",
        };
        return { operationId: options?.operationId ?? "op", state: terminal };
      }),
    });

    const { getResult, unmount } = renderConversation(transport);

    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = getResult().sendMessage("stream me");
      // flush microtasks so onState applies run id
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getResult().isStreaming).toBe(true);

    await act(async () => {
      await getResult().stop();
      resolveStream?.(undefined);
      await sendPromise!;
    });

    expect(ops).toContain(`cancel:${RUN_ID}`);
    expect(getResult().isStreaming).toBe(false);
    unmount();
  });

  it("approve uses exact approval_id + action_hash and one operation id", async () => {
    const { transport, ops } = makeTransport();
    const { getResult, unmount } = renderConversation(transport);
    const hash = "d".repeat(64);

    await act(async () => {
      await getResult().approveProposal(APPROVAL_ID, hash);
    });

    expect(ops.some((o) => o.startsWith(`approve:${APPROVAL_ID}:${hash}:`))).toBe(true);
    unmount();
  });

  it("stale generation after unmount does not throw", async () => {
    const { transport } = makeTransport();
    const { getResult, unmount } = renderConversation(transport);
    unmount();
    // Calling after unmount should be fenced; send may no-op safely.
    await act(async () => {
      await getResult().sendMessage("late");
    });
  });
});
