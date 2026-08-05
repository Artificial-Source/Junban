import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, storeToken, clearStoredToken } from "../api/client";
import { RetainedOperationId, resolveOperationId } from "./operation-id";
import {
  approveAiApproval,
  cancelAiRun,
  createAiMemory,
  createAiResponse,
  createAiSession,
  deleteAiCredential,
  discoverAiProviderModels,
  getAiApproval,
  getAiConfig,
  getAiMessage,
  listAiMessages,
  listAiProviders,
  listAiSessions,
  putAiConfig,
  putAiCredential,
  rejectAiApproval,
  sanitizeTransportError,
  updateAiSession,
} from "./transport";

const TOKEN = "test-bearer-token-value";
const OP = "11111111-1111-4111-8111-111111111111";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MESSAGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APPROVAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(wire: string): Response {
  return new Response(wire, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function envelope(sequence: number, type: string, payload: unknown): string {
  return JSON.stringify({
    version: 1,
    run_id: RUN,
    generation: 1,
    sequence,
    type,
    payload,
  });
}

type FetchReply =
  | Response
  | Error
  | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>);

function captureFetches() {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses: FetchReply[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) {
      return jsonResponse(200, {});
    }
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "function") {
      return next(input, init);
    }
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    enqueue(...items: FetchReply[]) {
      responses.push(...items);
    },
  };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as Record<string, string>;
}

describe("operation identity", () => {
  it("retains one id across same-action retries and mints a new id after reset", () => {
    const retained = new RetainedOperationId(OP);
    expect(retained.id).toBe(OP);
    expect(retained.id).toBe(OP);
    expect(resolveOperationId(retained.id)).toBe(OP);
    retained.reset();
    const next = retained.id;
    expect(next).not.toBe(OP);
    expect(resolveOperationId(next)).toBe(next);
  });
});

describe("AI transport request shapes", () => {
  beforeEach(() => {
    clearStoredToken();
    storeToken(TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearStoredToken();
  });

  it("lists providers and discovers models with GET auth and no idempotency key", async () => {
    const { calls, enqueue } = captureFetches();
    enqueue(
      jsonResponse(200, { providers: [] }),
      jsonResponse(200, { provider: "openai", models: [] }),
    );

    await listAiProviders();
    await discoverAiProviderModels("openai");

    expect(calls[0]?.url).toBe("/api/v1/ai/providers");
    expect(calls[0]?.init.method).toBe("GET");
    expect(headersOf(calls[0]?.init)).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(headersOf(calls[0]?.init)).not.toHaveProperty("Idempotency-Key");

    expect(calls[1]?.url).toBe("/api/v1/ai/providers/openai/models");
    expect(calls[1]?.init.method).toBe("GET");
  });

  it("reads and writes config with exact method/body/idempotency headers", async () => {
    const { calls, enqueue } = captureFetches();
    const configBody = {
      ai: {
        enabled: true,
        provider: "openai",
        model: "gpt-4.1",
        base_url: "https://api.openai.com/v1",
        smart_endpoint: true,
        auto_send: false,
        custom_instructions: "",
        daily_briefing_enabled: true,
        default_energy: null,
      },
      voice: {
        voice_mode: "push_to_talk",
        grace_period_ms: 500,
        cloud_speech_enabled: false,
        stt_provider: "browser",
        stt_model: null,
        tts_enabled: false,
        tts_provider: "browser",
        tts_model: null,
        tts_voice: null,
      },
    };
    enqueue(
      jsonResponse(200, { ai: {}, voice: {}, credentials: {} }),
      jsonResponse(200, { ai: {}, voice: {}, credentials: {} }),
    );

    await getAiConfig();
    await putAiConfig(configBody as never, { operationId: OP });

    expect(calls[0]?.url).toBe("/api/v1/ai/config");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[1]?.url).toBe("/api/v1/ai/config");
    expect(calls[1]?.init.method).toBe("PUT");
    expect(headersOf(calls[1]?.init)).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": OP,
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(configBody);
  });

  it("puts write-only credentials without retaining secrets in errors or retries incorrectly", async () => {
    const { calls, enqueue } = captureFetches();
    enqueue(
      jsonResponse(200, {
        target: "ai_provider",
        credential: {
          id: MESSAGE,
          kind: "api_key",
          present: true,
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
    );

    await putAiCredential(
      "ai_provider",
      { kind: "api_key", secret: "sk-super-secret-value" },
      { operationId: OP },
    );

    expect(calls[0]?.url).toBe("/api/v1/ai/credentials/ai_provider");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(headersOf(calls[0]?.init)).toMatchObject({
      "Idempotency-Key": OP,
      Authorization: `Bearer ${TOKEN}`,
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as { secret: string; kind: string };
    expect(body).toEqual({ kind: "api_key", secret: "sk-super-secret-value" });

    enqueue(
      jsonResponse(400, {
        request_id: "req-1",
        error: { code: "validation_failed", message: "invalid credential", retryable: false },
      }),
    );
    await expect(
      putAiCredential(
        "ai_provider",
        { kind: "api_key", secret: "sk-super-secret-value" },
        { operationId: OP },
      ),
    ).rejects.toBeInstanceOf(ApiError);

    enqueue(
      jsonResponse(400, {
        request_id: "req-2",
        error: { code: "validation_failed", message: "invalid credential", retryable: false },
      }),
    );
    try {
      await putAiCredential(
        "voice_stt",
        { kind: "api_key", secret: "sk-super-secret-value" },
        { operationId: OP },
      );
      expect.fail("expected ApiError");
    } catch (error) {
      const text = `${String(error)}\n${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`;
      expect(text).not.toContain("sk-super-secret-value");
      expect(text).not.toContain(TOKEN);
    }
  });

  it("creates sessions and lists messages with exact query encoding", async () => {
    const { calls, enqueue } = captureFetches();
    enqueue(
      jsonResponse(201, {
        session: {
          id: SESSION,
          title: "Chat",
          status: "active",
          message_count: 0,
          content_bytes: 0,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message_at: null,
        },
        event: {
          revision: 1,
          operation_id: OP,
          event_type: "ai_session.created",
          occurred_at: "2026-01-01T00:00:00Z",
          affected: {},
          resync: { tasks: false, catalog: false },
        },
      }),
      jsonResponse(200, { sessions: [], next_cursor: null }),
      jsonResponse(200, { messages: [] }),
      jsonResponse(200, {
        session: {
          id: SESSION,
          title: "Renamed",
          status: "active",
          message_count: 0,
          content_bytes: 0,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message_at: null,
        },
        event: {
          revision: 2,
          operation_id: OP,
          event_type: "ai_session.updated",
          occurred_at: "2026-01-01T00:00:00Z",
          affected: {},
          resync: { tasks: false, catalog: false },
        },
      }),
    );

    await createAiSession({ title: "Chat" }, { operationId: OP });
    await listAiSessions({ limit: 10, cursor: "abc" });
    await listAiMessages(SESSION, { after_sequence: 2, limit: 50 });
    await updateAiSession(SESSION, { title: "Renamed" }, { operationId: OP });

    expect(calls[0]?.url).toBe("/api/v1/ai/sessions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0]?.init)).toMatchObject({ "Idempotency-Key": OP });
    expect(calls[1]?.url).toBe("/api/v1/ai/sessions?limit=10&cursor=abc");
    expect(calls[2]?.url).toBe(`/api/v1/ai/sessions/${SESSION}/messages?after_sequence=2&limit=50`);
    expect(calls[3]?.init.method).toBe("PATCH");
  });

  it("resolves getAiMessage from the list window without inventing a route", async () => {
    const { calls, enqueue } = captureFetches();
    enqueue(
      jsonResponse(200, {
        messages: [
          {
            id: MESSAGE,
            session_id: SESSION,
            turn_id: RUN,
            role: "user",
            status: "completed",
            sequence: 1,
            content: { text: "hi" },
            content_bytes: 2,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );

    const message = await getAiMessage(SESSION, MESSAGE);
    expect(message?.id).toBe(MESSAGE);
    expect(calls[0]?.url).toBe(`/api/v1/ai/sessions/${SESSION}/messages`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("streams createAiResponse with fetch SSE, retained operation id, and no auto-retry", async () => {
    const { calls, enqueue } = captureFetches();
    const wire =
      `data: ${envelope(1, "run_started", { replay: true })}\n\n` +
      `data: ${envelope(2, "text_delta", { text: "ok" })}\n\n` +
      `data: ${envelope(3, "run_completed", { assistant_message_id: MESSAGE })}\n\n`;

    enqueue(new TypeError("Failed to fetch"));

    // Streaming POST must not auto-retry after ambiguous dispatch.
    await expect(
      createAiResponse(SESSION, { message: "hello" }, { operationId: OP }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/v1/ai/sessions/${SESSION}/responses`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0]?.init)).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": OP,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ message: "hello" });

    // Explicit same-action retry reuses the operation id.
    enqueue(sseResponse(wire));
    const result = await createAiResponse(SESSION, { message: "hello" }, { operationId: OP });
    expect(result.operationId).toBe(OP);
    expect(result.state.visibleText).toBe("ok");
    expect(result.state.terminal).toEqual({
      kind: "completed",
      assistantMessageId: MESSAGE,
    });
    expect(headersOf(calls[1]?.init)).toMatchObject({ "Idempotency-Key": OP });
  });

  it("cancels runs without an idempotency key and handles approval decide bodies", async () => {
    const { calls, enqueue } = captureFetches();
    enqueue(
      jsonResponse(200, { run_id: RUN, status: "cancel_requested" }),
      jsonResponse(200, {
        approval: {
          id: APPROVAL,
          session_id: SESSION,
          turn_id: RUN,
          run_id: RUN,
          generation: 1,
          tool_name: "create_task",
          arguments: {},
          action_hash: "a".repeat(64),
          status: "pending",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          expires_at: "2026-01-01T00:01:00Z",
        },
        message: {
          id: MESSAGE,
          session_id: SESSION,
          turn_id: RUN,
          role: "assistant",
          status: "streaming",
          sequence: 2,
          content: {},
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        run: {
          id: RUN,
          session_id: SESSION,
          turn_id: RUN,
          assistant_message_id: MESSAGE,
          generation: 1,
          state: "awaiting_approval",
          approval_id: APPROVAL,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
      jsonResponse(200, {
        approval: { id: APPROVAL, status: "approved" },
        message: { id: MESSAGE },
        run: { id: RUN, state: "dispatching" },
      }),
      jsonResponse(200, {
        approval: { id: APPROVAL, status: "rejected" },
        message: { id: MESSAGE },
        run: { id: RUN, state: "running" },
        result: { outcome: "error" },
      }),
    );

    await cancelAiRun(RUN);
    await getAiApproval(APPROVAL);
    await approveAiApproval(APPROVAL, { action_hash: "a".repeat(64) }, { operationId: OP });
    await rejectAiApproval(APPROVAL, { action_hash: "a".repeat(64) }, { operationId: OP });

    expect(calls[0]?.url).toBe(`/api/v1/ai/runs/${RUN}/cancel`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0]?.init)).not.toHaveProperty("Idempotency-Key");
    expect(calls[1]?.url).toBe(`/api/v1/ai/approvals/${APPROVAL}`);
    expect(calls[2]?.url).toBe(`/api/v1/ai/approvals/${APPROVAL}/approve`);
    expect(headersOf(calls[2]?.init)).toMatchObject({ "Idempotency-Key": OP });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ action_hash: "a".repeat(64) });
    expect(calls[3]?.url).toBe(`/api/v1/ai/approvals/${APPROVAL}/reject`);
  });

  it("creates memories and deletes credentials with exact routes", async () => {
    const { calls, enqueue } = captureFetches();
    enqueue(
      jsonResponse(201, {
        memory: {
          id: MESSAGE,
          content: "note",
          content_bytes: 4,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        event: {
          revision: 1,
          operation_id: OP,
          event_type: "ai_memory.created",
          occurred_at: "2026-01-01T00:00:00Z",
          affected: {},
          resync: { tasks: false, catalog: false },
        },
      }),
      jsonResponse(200, {
        target: "ai_provider",
        credential: null,
      }),
    );

    await createAiMemory({ content: "note" }, { operationId: OP });
    await deleteAiCredential("ai_provider", { operationId: OP });

    expect(calls[0]?.url).toBe("/api/v1/ai/memories");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[1]?.url).toBe("/api/v1/ai/credentials/ai_provider");
    expect(calls[1]?.init.method).toBe("DELETE");
  });

  it("supports AbortSignal on streaming create and does not use EventSource", async () => {
    const eventSourceSpy = vi.fn();
    vi.stubGlobal(
      "EventSource",
      class {
        constructor() {
          eventSourceSpy();
        }
      },
    );

    const { enqueue } = captureFetches();
    const abort = new AbortController();
    enqueue((_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      // Abort before body consumption so the stream pump observes the signal.
      abort.abort();
      return sseResponse(`data: ${envelope(1, "text_delta", { text: "x" })}\n\n`);
    });

    const result = await createAiResponse(
      SESSION,
      { message: "hi" },
      { operationId: OP, signal: abort.signal },
    );
    expect(result.state.terminal?.kind).toBe("interrupted");
    expect(eventSourceSpy).not.toHaveBeenCalled();
  });
});

describe("sanitizeTransportError", () => {
  it("redacts bearer tokens and secret material from unexpected errors", () => {
    const error = sanitizeTransportError(
      new Error(`Authorization: Bearer ${TOKEN} secret=sk-abc body:{"secret":"sk-abc"}`),
    );
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("sk-abc");
    expect(error.message).toMatch(/redacted/i);
  });
});
