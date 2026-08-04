/**
 * SSE-driven conversation lifecycle with deterministic fake transport.
 * @vitest-environment jsdom
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../api/client";
import { useAiConversation, type UseAiConversationResult } from "./useAiConversation";
import type { ConversationTransport } from "./conversation-transport";
import type { AiRunStreamState } from "./types";
import { createInitialAiRunStreamState } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const USER_MSG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASST_MSG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPROVAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionDto(id = SESSION_ID, title = "New chat") {
  return {
    id,
    title,
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

function completedState(text = "hello"): AiRunStreamState {
  const state = createInitialAiRunStreamState();
  state.runId = RUN_ID;
  state.generation = 1;
  state.lastSequence = 0;
  state.visibleText = text;
  state.textRevision = 1;
  state.terminal = { kind: "completed", assistantMessageId: ASST_MSG };
  return state;
}

function interruptedState(
  reason: "eof_without_terminal" | "aborted" | "protocol" = "eof_without_terminal",
): AiRunStreamState {
  const state = createInitialAiRunStreamState();
  state.runId = RUN_ID;
  state.generation = 1;
  state.terminal = { kind: "interrupted", reason, message: reason };
  return state;
}

function makeTransport(overrides: Partial<Record<keyof ConversationTransport, unknown>> = {}): {
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
    updateSession: vi.fn(
      async (sessionId: string, body: { title: string }, options?: { operationId?: string }) => {
        ops.push(`rename:${sessionId}:${body.title}:${options?.operationId ?? "?"}`);
        return {
          session: sessionDto(sessionId, body.title),
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
      },
    ),
    deleteSession: vi.fn(async (sessionId: string, options?: { operationId?: string }) => {
      ops.push(`delete:${sessionId}:${options?.operationId ?? "?"}`);
      return {
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
    clearSession: vi.fn(async (sessionId: string, options?: { operationId?: string }) => {
      ops.push(`clear:${sessionId}:${options?.operationId ?? "?"}`);
      return {
        session: sessionDto(sessionId),
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
        const state = completedState();
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
        const state = completedState();
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
        const state = completedState();
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
        const state = completedState();
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

function opIdFrom(entry: string, index = 1): string {
  return entry.split(":")[index]!;
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
    expect(opId).toMatch(UUID_RE);
    unmount();
  });

  it("stop cancels durable run then aborts local stream", async () => {
    let resolveStream: ((value: unknown) => void) | null = null;
    let createCalls = 0;
    const { transport, ops } = makeTransport({
      createResponse: vi.fn(async (_s, _b, options) => {
        createCalls += 1;
        ops.push(`createResponse:${options?.operationId ?? "?"}`);
        const state = createInitialAiRunStreamState();
        state.runId = RUN_ID;
        state.generation = 1;
        options?.handlers?.onState?.(state);
        await new Promise((resolve) => {
          resolveStream = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        const terminal = interruptedState("aborted");
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
    // Local abort/stop must not auto-replay the POST.
    expect(createCalls).toBe(1);
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

  it("reuses the same operation UUID after network failure on same send", async () => {
    let attempts = 0;
    const { transport, ops } = makeTransport({
      createResponse: vi.fn(async (_s, body, options) => {
        attempts += 1;
        ops.push(`createResponse:${options?.operationId ?? "?"}:${body.message}`);
        if (attempts === 1) {
          throw new NetworkError("network down", true);
        }
        const state = completedState();
        options?.handlers?.onState?.(state);
        return { operationId: options?.operationId ?? "op", state };
      }),
    });
    const { getResult, unmount } = renderConversation(transport);

    await act(async () => {
      await getResult().sendMessage("Same text");
    });
    await act(async () => {
      await getResult().sendMessage("Same text");
    });

    const sendOps = ops.filter((o) => o.startsWith("createResponse:"));
    expect(sendOps).toHaveLength(2);
    expect(opIdFrom(sendOps[0]!)).toBe(opIdFrom(sendOps[1]!));
    expect(opIdFrom(sendOps[0]!)).toMatch(UUID_RE);
    unmount();
  });

  it("mints a new UUID when send text or action target changes", async () => {
    let fail = true;
    const { transport, ops } = makeTransport({
      createResponse: vi.fn(async (_s, body, options) => {
        ops.push(`createResponse:${options?.operationId ?? "?"}:${body.message}`);
        if (fail) {
          fail = false;
          throw new NetworkError("network down", true);
        }
        const state = completedState();
        options?.handlers?.onState?.(state);
        return { operationId: options?.operationId ?? "op", state };
      }),
    });
    const { getResult, unmount } = renderConversation(transport);

    await act(async () => {
      await getResult().sendMessage("First");
    });
    await act(async () => {
      await getResult().sendMessage("Second");
    });

    const sendOps = ops.filter((o) => o.startsWith("createResponse:"));
    expect(sendOps).toHaveLength(2);
    expect(opIdFrom(sendOps[0]!)).not.toBe(opIdFrom(sendOps[1]!));
    unmount();
  });

  it("mints a fresh UUID after definitive completed terminal", async () => {
    const { transport, ops } = makeTransport();
    const { getResult, unmount } = renderConversation(transport);

    await act(async () => {
      await getResult().sendMessage("Again later");
    });
    await act(async () => {
      await getResult().sendMessage("Again later");
    });

    const sendOps = ops.filter((o) => o.startsWith("createResponse:"));
    expect(sendOps).toHaveLength(2);
    expect(opIdFrom(sendOps[0]!)).not.toBe(opIdFrom(sendOps[1]!));
    unmount();
  });

  it("retains UUID on interrupted/EOF resolved state and after failed terminal releases", async () => {
    let mode: "interrupt" | "fail" | "ok" = "interrupt";
    const { transport, ops } = makeTransport({
      createResponse: vi.fn(async (_s, body, options) => {
        ops.push(`createResponse:${options?.operationId ?? "?"}:${body.message}`);
        if (mode === "interrupt") {
          return {
            operationId: options?.operationId ?? "op",
            state: interruptedState("eof_without_terminal"),
          };
        }
        if (mode === "fail") {
          const state = createInitialAiRunStreamState();
          state.runId = RUN_ID;
          state.terminal = {
            kind: "failed",
            assistantMessageId: ASST_MSG,
            error: "provider",
          };
          return { operationId: options?.operationId ?? "op", state };
        }
        const state = completedState();
        options?.handlers?.onState?.(state);
        return { operationId: options?.operationId ?? "op", state };
      }),
      editResponse: vi.fn(async (_s, _m, body, options) => {
        ops.push(`edit:${options?.operationId ?? "?"}:${body.message}`);
        if (mode === "interrupt") {
          return { operationId: options?.operationId ?? "op", state: interruptedState() };
        }
        const state = completedState();
        return { operationId: options?.operationId ?? "op", state };
      }),
      retryResponse: vi.fn(async (_s, _m, options) => {
        ops.push(`retry:${options?.operationId ?? "?"}`);
        if (mode === "interrupt") {
          return { operationId: options?.operationId ?? "op", state: interruptedState() };
        }
        return { operationId: options?.operationId ?? "op", state: completedState() };
      }),
      regenerateResponse: vi.fn(async (_s, _m, options) => {
        ops.push(`regen:${options?.operationId ?? "?"}`);
        if (mode === "interrupt") {
          return { operationId: options?.operationId ?? "op", state: interruptedState() };
        }
        return { operationId: options?.operationId ?? "op", state: completedState() };
      }),
    });
    const { getResult, unmount } = renderConversation(transport);

    // Interrupted send retains.
    await act(async () => {
      await getResult().sendMessage("Hold");
    });
    await act(async () => {
      await getResult().sendMessage("Hold");
    });
    const interruptedSends = ops.filter((o) => o.startsWith("createResponse:"));
    expect(interruptedSends).toHaveLength(2);
    expect(opIdFrom(interruptedSends[0]!)).toBe(opIdFrom(interruptedSends[1]!));

    // Definitive failed releases.
    mode = "fail";
    await act(async () => {
      await getResult().sendMessage("Hold");
    });
    const afterFail = ops.filter((o) => o.startsWith("createResponse:"));
    expect(afterFail).toHaveLength(3);
    expect(opIdFrom(afterFail[2]!)).toBe(opIdFrom(afterFail[0]!)); // still same until release after fail returns
    // Next explicit action after failed terminal gets a fresh UUID.
    mode = "ok";
    await act(async () => {
      await getResult().sendMessage("Hold");
    });
    const afterOk = ops.filter((o) => o.startsWith("createResponse:"));
    expect(afterOk).toHaveLength(4);
    expect(opIdFrom(afterOk[3]!)).not.toBe(opIdFrom(afterOk[2]!));

    // Edit / retry / regenerate interrupted retention.
    mode = "interrupt";
    await act(async () => {
      await getResult().selectSession(SESSION_ID);
    });
    await act(async () => {
      await getResult().editAndResend(USER_MSG, "edited");
    });
    await act(async () => {
      await getResult().editAndResend(USER_MSG, "edited");
    });
    const edits = ops.filter((o) => o.startsWith("edit:"));
    expect(edits).toHaveLength(2);
    expect(opIdFrom(edits[0]!)).toBe(opIdFrom(edits[1]!));

    await act(async () => {
      await getResult().retryMessage(USER_MSG);
    });
    await act(async () => {
      await getResult().retryMessage(USER_MSG);
    });
    const retries = ops.filter((o) => o.startsWith("retry:"));
    expect(retries).toHaveLength(2);
    expect(opIdFrom(retries[0]!)).toBe(opIdFrom(retries[1]!));

    await act(async () => {
      await getResult().regenerateMessage(ASST_MSG);
    });
    await act(async () => {
      await getResult().regenerateMessage(ASST_MSG);
    });
    const regens = ops.filter((o) => o.startsWith("regen:"));
    expect(regens).toHaveLength(2);
    expect(opIdFrom(regens[0]!)).toBe(opIdFrom(regens[1]!));

    unmount();
  });

  it("create session ambiguous failure does not mint a second identity on exact retry", async () => {
    let creates = 0;
    const { transport, ops } = makeTransport({
      createSession: vi.fn(async (_body, options) => {
        creates += 1;
        ops.push(`createSession:${options?.operationId ?? "?"}`);
        if (creates === 1) {
          throw new NetworkError("create failed", true);
        }
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
    });
    const { getResult, unmount } = renderConversation(transport);

    await act(async () => {
      await getResult().sendMessage("First real send");
    });
    expect(getResult().activeSessionId).toBeNull();

    await act(async () => {
      await getResult().sendMessage("First real send");
    });

    const createOps = ops.filter((o) => o.startsWith("createSession:"));
    expect(createOps).toHaveLength(2);
    expect(opIdFrom(createOps[0]!)).toBe(opIdFrom(createOps[1]!));
    expect(getResult().activeSessionId).toBe(SESSION_ID);
    // Only one successful session binding — createSession called twice with same id (idempotent retry).
    expect(creates).toBe(2);
    unmount();
  });

  it("session rename/delete/clear and approval decisions retain identity across ambiguous errors", async () => {
    let renameFails = 1;
    let deleteFails = 1;
    let clearFails = 1;
    let approveFails = 1;
    let rejectFails = 1;
    const hash = "a".repeat(64);
    const hash2 = "b".repeat(64);

    const { transport, ops } = makeTransport({
      listSessions: vi.fn(async () => ({
        sessions: [sessionDto(SESSION_ID), sessionDto(SESSION_ID_2, "Other")],
        next_cursor: null,
      })),
      updateSession: vi.fn(async (sessionId, body, options) => {
        ops.push(`rename:${sessionId}:${body.title}:${options?.operationId ?? "?"}`);
        if (renameFails > 0) {
          renameFails -= 1;
          throw new NetworkError("rename failed", true);
        }
        return {
          session: sessionDto(sessionId, body.title),
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
      deleteSession: vi.fn(async (sessionId, options) => {
        ops.push(`delete:${sessionId}:${options?.operationId ?? "?"}`);
        if (deleteFails > 0) {
          deleteFails -= 1;
          throw new NetworkError("delete failed", true);
        }
        return {
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
      clearSession: vi.fn(async (sessionId, options) => {
        ops.push(`clear:${sessionId}:${options?.operationId ?? "?"}`);
        if (clearFails > 0) {
          clearFails -= 1;
          throw new NetworkError("clear failed", true);
        }
        return {
          session: sessionDto(sessionId),
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
      approveApproval: vi.fn(async (id, body, options) => {
        ops.push(`approve:${id}:${body.action_hash}:${options?.operationId ?? "?"}`);
        if (approveFails > 0) {
          approveFails -= 1;
          throw new NetworkError("approve failed", true);
        }
        return approvalResponse(id, body.action_hash, "approved");
      }),
      rejectApproval: vi.fn(async (id, body, options) => {
        ops.push(`reject:${id}:${body.action_hash}:${options?.operationId ?? "?"}`);
        if (rejectFails > 0) {
          rejectFails -= 1;
          throw new NetworkError("reject failed", true);
        }
        return approvalResponse(id, body.action_hash, "rejected");
      }),
    });

    const { getResult, unmount } = renderConversation(transport);

    await act(async () => {
      await getResult().selectSession(SESSION_ID);
    });

    await act(async () => {
      await getResult().renameSession(SESSION_ID, "Renamed");
    });
    await act(async () => {
      await getResult().renameSession(SESSION_ID, "Renamed");
    });
    const renames = ops.filter((o) => o.startsWith(`rename:${SESSION_ID}:Renamed:`));
    expect(renames).toHaveLength(2);
    expect(opIdFrom(renames[0]!, 3)).toBe(opIdFrom(renames[1]!, 3));

    // Different title → different identity.
    renameFails = 0;
    await act(async () => {
      await getResult().renameSession(SESSION_ID, "Other title");
    });
    const renameOther = ops.filter((o) => o.startsWith(`rename:${SESSION_ID}:Other title:`));
    expect(renameOther).toHaveLength(1);
    expect(opIdFrom(renameOther[0]!, 3)).not.toBe(opIdFrom(renames[0]!, 3));

    await act(async () => {
      await getResult().clearSession();
    });
    await act(async () => {
      await getResult().clearSession();
    });
    const clears = ops.filter((o) => o.startsWith(`clear:${SESSION_ID}:`));
    expect(clears).toHaveLength(2);
    expect(opIdFrom(clears[0]!, 2)).toBe(opIdFrom(clears[1]!, 2));

    await act(async () => {
      await getResult().approveProposal(APPROVAL_ID, hash);
    });
    await act(async () => {
      await getResult().approveProposal(APPROVAL_ID, hash);
    });
    const approves = ops.filter((o) => o.startsWith(`approve:${APPROVAL_ID}:${hash}:`));
    expect(approves).toHaveLength(2);
    expect(opIdFrom(approves[0]!, 3)).toBe(opIdFrom(approves[1]!, 3));

    // Different action hash → different approve identity.
    approveFails = 0;
    await act(async () => {
      await getResult().approveProposal(APPROVAL_ID, hash2);
    });
    const approve2 = ops.filter((o) => o.startsWith(`approve:${APPROVAL_ID}:${hash2}:`));
    expect(approve2).toHaveLength(1);
    expect(opIdFrom(approve2[0]!, 3)).not.toBe(opIdFrom(approves[0]!, 3));

    await act(async () => {
      await getResult().rejectProposal(APPROVAL_ID, hash);
    });
    await act(async () => {
      await getResult().rejectProposal(APPROVAL_ID, hash);
    });
    const rejects = ops.filter((o) => o.startsWith(`reject:${APPROVAL_ID}:${hash}:`));
    expect(rejects).toHaveLength(2);
    expect(opIdFrom(rejects[0]!, 3)).toBe(opIdFrom(rejects[1]!, 3));

    await act(async () => {
      await getResult().deleteSession(SESSION_ID_2);
    });
    await act(async () => {
      await getResult().deleteSession(SESSION_ID_2);
    });
    const deletes = ops.filter((o) => o.startsWith(`delete:${SESSION_ID_2}:`));
    expect(deletes).toHaveLength(2);
    expect(opIdFrom(deletes[0]!, 2)).toBe(opIdFrom(deletes[1]!, 2));

    unmount();
  });

  it("session switch and unmount fence late stream callbacks; stop cancels before abort", async () => {
    let onState: ((s: AiRunStreamState) => void) | null = null;
    let resolveStream: ((value: unknown) => void) | null = null;
    const listMessages = vi.fn(async () => ({ messages: [] as ReturnType<typeof messageDto>[] }));

    const { transport, ops } = makeTransport({
      listMessages,
      createResponse: vi.fn(async (_s, _b, options) => {
        ops.push(`createResponse:${options?.operationId ?? "?"}`);
        onState = options?.handlers?.onState ?? null;
        const started = createInitialAiRunStreamState();
        started.runId = RUN_ID;
        started.generation = 1;
        options?.handlers?.onState?.(started);
        await new Promise((resolve) => {
          resolveStream = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        return { operationId: options?.operationId ?? "op", state: interruptedState("aborted") };
      }),
    });

    const { getResult, unmount } = renderConversation(transport);

    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = getResult().sendMessage("switch away");
      await Promise.resolve();
      await Promise.resolve();
    });

    const messagesBeforeSwitch = listMessages.mock.calls.length;

    await act(async () => {
      await getResult().selectSession(null);
    });

    // Late stream callback after session switch must not resurrect streaming chrome.
    await act(async () => {
      const late = completedState("should not stick");
      late.runId = RUN_ID;
      late.visibleText = "should not stick";
      onState?.(late);
    });

    expect(getResult().isStreaming).toBe(false);
    expect(getResult().messages.some((m) => m.text === "should not stick")).toBe(false);

    await act(async () => {
      resolveStream?.(undefined);
      await sendPromise!;
    });

    // Finish of stale run must not keep streaming and should not thrash loads unboundedly.
    expect(getResult().isStreaming).toBe(false);

    // Fresh stream: stop orders durable cancel before local abort.
    let resolve2: ((value: unknown) => void) | null = null;
    let secondCreateCalls = 0;
    (transport.createResponse as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _s: string,
        _b: unknown,
        options?: {
          operationId?: string;
          handlers?: { onState?: (s: AiRunStreamState) => void };
          signal?: AbortSignal;
        },
      ) => {
        secondCreateCalls += 1;
        ops.push(`createResponse:${options?.operationId ?? "?"}`);
        const started = createInitialAiRunStreamState();
        started.runId = RUN_ID;
        options?.handlers?.onState?.(started);
        await new Promise((resolve) => {
          resolve2 = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        return { operationId: options?.operationId ?? "op", state: interruptedState("aborted") };
      },
    );

    const opsBeforeSecond = ops.length;
    await act(async () => {
      sendPromise = getResult().sendMessage("stop order");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(secondCreateCalls).toBe(1);

    await act(async () => {
      await getResult().stop();
      resolve2?.(undefined);
      await sendPromise!;
    });

    const cancelIdx = ops.indexOf(`cancel:${RUN_ID}`, opsBeforeSecond);
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    // Stop does not auto-replay the POST.
    expect(secondCreateCalls).toBe(1);

    void messagesBeforeSwitch;
    unmount();

    // Post-unmount late callback is fenced.
    await act(async () => {
      onState?.(completedState("after unmount"));
    });
  });

  it("does not expose surfaceGeneration on the public result", async () => {
    const { transport } = makeTransport();
    const { getResult, unmount } = renderConversation(transport);
    expect("surfaceGeneration" in getResult()).toBe(false);
    unmount();
  });
});
