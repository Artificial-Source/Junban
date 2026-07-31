import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  NetworkError,
  acquireReminderLease,
  addRelation,
  appendTimeSlotTask,
  bootstrapFragmentToken,
  bulkTasks,
  claimDueReminders,
  clearStoredToken,
  createComment,
  createProject,
  createTask,
  createTimeBlock,
  dismissReminder,
  generateOperationId,
  getDopamineMenu,
  getDailyPlan,
  getStats,
  getWeeklyReview,
  getStoredToken,
  getTemporalSettings,
  hasStoredToken,
  listCalendarTasks,
  listTaskReminders,
  listTasks,
  listTimeBlocks,
  moveTask,
  parseQuickEntry,
  patchTask,
  replanTimeBlocks,
  rescheduleReminder,
  settleReminderDelivered,
  storeToken,
  subscribeToEvents,
  undoOperation,
  type SseEvent,
} from "./client";

function setLocation(hash: string, search = "") {
  vi.stubGlobal("location", {
    hash,
    pathname: "/today",
    search,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mutationEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      revision: 1,
      operation_id: "11111111-1111-4111-8111-111111111111",
      event_type: "task.created",
      occurred_at: "2026-07-28T00:00:00Z",
      affected: { task_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
      resync: { tasks: false, catalog: false },
      primary: {
        resource_type: "task",
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      snapshot: {
        resource_type: "task",
        task: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          title: "Task",
          description: "",
          someday: false,
          tag_ids: [],
          sort_order: 0,
          status: "pending",
          created_at: "2026-07-28T00:00:00Z",
          updated_at: "2026-07-28T00:00:00Z",
          revision: 1,
          due_date: null,
          completed_at: null,
        },
      },
      ...overrides,
    },
  };
}

describe("fragment token bootstrap", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.stubGlobal("history", { ...history, replaceState: vi.fn() });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts one decoded fragment token, strips query tokens, and uses session storage only", () => {
    setLocation("#access_token=test%2Dsecret+token", "?view=compact&access_token=query-token");

    expect(bootstrapFragmentToken()).toBe(true);
    expect(getStoredToken()).toBe("test-secret token");
    expect(localStorage.getItem("junban-access-token")).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/today?view=compact");
  });

  it.each([
    "#access_token=",
    "#access_token=first&access_token=second",
    "#access_token=first&other=value",
    "#other=value",
    "#access_token=%E0%A4%A",
  ])("rejects malformed fragment %s while scrubbing it", (hash) => {
    setLocation(hash, "?view=compact");

    expect(bootstrapFragmentToken()).toBe(false);
    expect(getStoredToken()).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/today?view=compact");
  });

  it("rejects and removes a query token without affecting unrelated query parameters", () => {
    setLocation("", "?view=compact&access_token=query-token&filter=open");

    expect(bootstrapFragmentToken()).toBe(false);
    expect(getStoredToken()).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/today?view=compact&filter=open");
  });
});

describe("token storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("stores and retrieves tokens from sessionStorage", () => {
    storeToken("my-token");
    expect(getStoredToken()).toBe("my-token");
    expect(hasStoredToken()).toBe(true);
  });

  it("clears tokens from sessionStorage", () => {
    storeToken("my-token");
    clearStoredToken();
    expect(getStoredToken()).toBeNull();
    expect(hasStoredToken()).toBe(false);
  });
});

describe("generateOperationId", () => {
  it("generates a valid UUID v4 string", () => {
    const id = generateOperationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateOperationId()));
    expect(ids.size).toBe(100);
  });
});

describe("mutation transport retries", () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeToken("test-token");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("retries one transport failure with the same idempotency key and body", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(jsonResponse(201, mutationEvent()));
    vi.stubGlobal("fetch", fetchMock);

    const body = { title: "Retry task", due_date: null };
    await createTask(body, "11111111-1111-4111-8111-111111111111");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const requestInit = init as RequestInit;
      expect(requestInit.credentials).toBe("same-origin");
      expect(requestInit.headers).toMatchObject({
        "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
      });
      expect(requestInit.body).toBe(JSON.stringify(body));
    }
  });

  it("does not retry an HTTP error envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(422, {
        request_id: "request-id",
        error: {
          code: "validation_error",
          message: "Title is invalid",
          retryable: false,
          fields: { title: "required" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createTask({ title: "", due_date: null }, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      code: "validation_error",
      fields: { title: "required" },
      requestId: "request-id",
    } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns malformed HTTP errors into NetworkError without retrying or leaking bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>secret-token</html>", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createTask({ title: "Task", due_date: null }, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(NetworkError);
      expect(String(error)).not.toContain("secret-token");
      expect(String(error)).not.toContain("<html>");
      return true;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("captures optional error details without treating them as retryable transport failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        request_id: "req-2",
        error: {
          code: "conflict",
          message: "Conflict",
          retryable: false,
          details: { reason: "duplicate" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await createTask({ title: "Task" }, "11111111-1111-4111-8111-111111111111").catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      details: { reason: "duplicate" },
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out hanging ordinary fetches once per attempt and retries mutations with the same key", async () => {
    vi.useFakeTimers();
    const body = { title: "Hanging create" };
    const opId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected abort signal"));
          return;
        }
        const onAbort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = createTask(body, opId);
    // Attach rejection handler before advancing timers so the retry rejection is not unhandled.
    const expectation = expect(pending).rejects.toMatchObject({
      name: "NetworkError",
      message: "Request timed out",
      retryable: true,
      aborted: false,
    } satisfies Partial<NetworkError>);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await expectation;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const requestInit = init as RequestInit;
      expect(requestInit.headers).toMatchObject({ "Idempotency-Key": opId });
      expect(requestInit.body).toBe(JSON.stringify(body));
    }

    vi.useRealTimers();
  });

  it("times out hanging parse/quick-entry calls as a retryable network error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected abort signal"));
          return;
        }
        const onAbort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = parseQuickEntry({ input: "buy milk p1" });
    const expectation = expect(pending).rejects.toMatchObject({
      name: "NetworkError",
      message: "Request timed out",
      retryable: true,
      aborted: false,
    } satisfies Partial<NetworkError>);

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("leaves the authenticated event stream unbounded by the ordinary request timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {
        /* intentionally never settles */
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cleanup = subscribeToEvents(vi.fn(), vi.fn(), vi.fn());
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);

    // Far beyond DEFAULT_REQUEST_TIMEOUT_MS — stream must stay open.
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 4);
    expect(signal?.aborted).toBe(false);

    cleanup();
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});

describe("endpoint request shapes", () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeToken("test-token");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists tasks with view, filters, and clamped page limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        tasks: [],
        revision: 0,
        as_of_date: "2026-07-28",
        next_cursor: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listTasks({
      view: "today",
      project_id: "-",
      section_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tag_ids: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "pending,completed",
      limit: 500,
      cursor: "opaque-cursor",
      sort: "due_asc",
      overdue: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/tasks?");
    expect(url).toContain("view=today");
    expect(url).toContain("project_id=-");
    expect(url).toContain(
      "tag_ids=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa%2Cbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(url).toContain("status=pending%2Ccompleted");
    expect(url).toContain("limit=100");
    expect(url).toContain("cursor=opaque-cursor");
    expect(url).toContain("overdue=true");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("omits client-generated ids from create bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(201, mutationEvent())));
    vi.stubGlobal("fetch", fetchMock);

    await createTask(
      { title: "No id", due_date: null, description: "x" },
      "11111111-1111-4111-8111-111111111111",
    );
    await createProject({ name: "Work", color: "#fff" }, "22222222-2222-4222-8222-222222222222");
    await createComment(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { content: "Hello" },
      "33333333-3333-4333-8333-333333333333",
    );

    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("id");
    }
  });

  it("patches tasks, moves with explicit anchors, and posts nested bulk actions", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(200, mutationEvent())));
    vi.stubGlobal("fetch", fetchMock);

    await patchTask(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { title: "Updated", priority: null },
      "11111111-1111-4111-8111-111111111111",
    );
    await moveTask(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      {
        project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        section_id: null,
        parent_id: null,
        order: { after: { task_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
      },
      "22222222-2222-4222-8222-222222222222",
    );
    await bulkTasks(
      {
        task_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
        action: {
          type: "move",
          target: {
            project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            order: "keep",
          },
        },
      },
      "33333333-3333-4333-8333-333333333333",
    );
    await addRelation(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { to_task_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "blocks" },
      "44444444-4444-4444-8444-444444444444",
    );
    await undoOperation(
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    );
    await parseQuickEntry({ input: "Buy milk tomorrow #errands" });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      body: (init as RequestInit).body
        ? (JSON.parse(String((init as RequestInit).body)) as unknown)
        : undefined,
      headers: (init as RequestInit).headers as Record<string, string>,
    }));

    expect(calls[0]).toMatchObject({
      url: "/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      method: "PATCH",
      body: { title: "Updated", priority: null },
    });
    expect(calls[1]).toMatchObject({
      url: "/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/move",
      method: "POST",
      body: {
        order: { after: { task_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
      },
    });
    expect(calls[2]).toMatchObject({
      url: "/api/v1/tasks/actions",
      method: "POST",
      body: {
        action: {
          type: "move",
          target: { order: "keep" },
        },
      },
    });
    // Nested bulk shape must remain unknown-property-safe (no flattened fields).
    expect(calls[2]?.body).toEqual({
      task_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      action: {
        type: "move",
        target: {
          project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          order: "keep",
        },
      },
    });
    expect(calls[3]).toMatchObject({
      url: "/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/relations",
      method: "POST",
    });
    expect(calls[4]).toMatchObject({
      url: "/api/v1/operations/55555555-5555-4555-8555-555555555555/undo",
      method: "POST",
      headers: expect.objectContaining({
        "Idempotency-Key": "66666666-6666-4666-8666-666666666666",
      }),
    });
    expect(calls[5]).toMatchObject({
      url: "/api/v1/parse/quick-entry",
      method: "POST",
      body: { input: "Buy milk tomorrow #errands" },
    });
    expect(calls[5]?.headers["Idempotency-Key"]).toBeUndefined();
  });
});

describe("event stream lifecycle", () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeToken("test-token");
  });

  afterEach(() => vi.unstubAllGlobals());

  function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("surfaces terminal authentication failures without reconnecting", async () => {
    const onReconnect = vi.fn();
    const onTerminal = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { error: "not used by stream parsing" })),
    );

    const cleanup = subscribeToEvents(vi.fn(), onReconnect, onTerminal);

    await vi.waitFor(() => {
      expect(onTerminal).toHaveBeenCalledWith({
        kind: "authentication",
        message: "Event stream authentication failed.",
      });
    });
    expect(onReconnect).not.toHaveBeenCalled();
    cleanup();
  });

  it("surfaces a non-stream response as a terminal protocol error", async () => {
    const onReconnect = vi.fn();
    const onTerminal = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("not an event stream", { headers: { "content-type": "application/json" } }),
        ),
    );

    const cleanup = subscribeToEvents(vi.fn(), onReconnect, onTerminal);

    await vi.waitFor(() => {
      expect(onTerminal).toHaveBeenCalledWith({
        kind: "protocol",
        message: "Event stream returned an invalid response.",
      });
    });
    expect(onReconnect).not.toHaveBeenCalled();
    cleanup();
  });

  it("aborts an in-flight connection on cleanup", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );

    const cleanup = subscribeToEvents(vi.fn(), vi.fn(), vi.fn());
    await vi.waitFor(() => expect(signal).toBeDefined());
    cleanup();
    expect(signal?.aborted).toBe(true);
  });

  it("parses committed envelopes, dedupes by revision, and sends Last-Event-ID on reconnect", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    const onResync = vi.fn();
    const eventPayload = {
      revision: 3,
      operation_id: "11111111-1111-4111-8111-111111111111",
      event_type: "task.updated",
      occurred_at: "2026-07-28T00:00:00Z",
      affected: { task_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
      resync: { tasks: false, catalog: false },
      primary: { resource_type: "task", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      snapshot: null,
    };
    const duplicate = { ...eventPayload };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([
          `id: 3\nevent: revision\ndata: ${JSON.stringify(eventPayload)}\n\n`,
          `id: 3\nevent: revision\ndata: ${JSON.stringify(duplicate)}\n\n`,
        ]),
      )
      .mockImplementationOnce(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    const cleanup = subscribeToEvents(onEvent, onReconnect, vi.fn(), 0, onResync);

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    const firstEvent = onEvent.mock.calls[0]?.[0] as SseEvent | undefined;
    expect(firstEvent?.data.revision).toBe(3);

    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall).toBeDefined();
    const secondInit = secondCall![1] as RequestInit;
    const secondHeaders = secondInit.headers as Record<string, string>;
    expect(secondHeaders["Last-Event-ID"]).toBe("3");
    expect(String(secondCall![0])).toContain("since=3");
    cleanup();
    vi.useRealTimers();
  });

  it("treats sync.resync_required and unknown event types as resync, not fatal", async () => {
    const onEvent = vi.fn();
    const onTerminal = vi.fn();
    const onResync = vi.fn();
    const resyncEvent = {
      revision: 4,
      operation_id: "00000000-0000-0000-0000-000000000000",
      event_type: "sync.resync_required",
      occurred_at: "2026-07-28T00:00:00Z",
      affected: {},
      resync: { tasks: true, catalog: true },
    };
    const unknownEvent = {
      revision: 5,
      operation_id: "11111111-1111-4111-8111-111111111111",
      event_type: "future.capability",
      occurred_at: "2026-07-28T00:00:01Z",
      affected: {},
      resync: { tasks: true, catalog: false },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamResponse([
            `id: 4\ndata: ${JSON.stringify(resyncEvent)}\n\n`,
            `id: 5\ndata: ${JSON.stringify(unknownEvent)}\n\n`,
          ]),
        ),
    );

    const cleanup = subscribeToEvents(onEvent, vi.fn(), onTerminal, 0, onResync);

    await vi.waitFor(() => expect(onResync).toHaveBeenCalledTimes(2));
    expect(onResync).toHaveBeenNthCalledWith(
      1,
      { tasks: true, catalog: true },
      "sync.resync_required",
    );
    expect(onResync).toHaveBeenNthCalledWith(
      2,
      { tasks: true, catalog: false },
      "unknown_event_type",
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("Phase 3 endpoint request shapes", () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeToken("test-token");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists calendar tasks with civil range and optional project filter", async () => {
    const body = { revision: 3, tasks: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listCalendarTasks({
      from: "2026-07-01",
      to: "2026-07-31",
      project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(result).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/v1/calendar/tasks?from=2026-07-01&to=2026-07-31&project_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("surfaces calendar range errors through ApiError without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(422, {
        request_id: "req-cal",
        error: {
          code: "RESULT_LIMIT_EXCEEDED",
          message: "Calendar range exceeds 42 days.",
          retryable: false,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCalendarTasks({ from: "2026-07-01", to: "2026-09-01" })).rejects.toMatchObject(
      {
        name: "ApiError",
        code: "RESULT_LIMIT_EXCEEDED",
        status: 422,
        retryable: false,
        requestId: "req-cal",
      } satisfies Partial<ApiError>,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires a full stats payload shape from the server", async () => {
    const body = {
      revision: 2,
      from: "2026-07-17",
      to: "2026-07-23",
      days: [{ date: "2026-07-23", completions: 3, creations: 1, completion_minutes: 90 }],
      current_streak_days: 7,
      estimate_accuracy_percent: 88,
      estimate_accuracy_samples: 14,
      total_completion_minutes: 1500,
      total_completions: 15,
      total_creations: 4,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getStats({ from: "2026-07-17", to: "2026-07-23" });
    expect(result).toEqual(body);
    expect(Array.isArray(result.days)).toBe(true);
    expect(result.days[0]).toMatchObject({
      date: "2026-07-23",
      completions: 3,
      creations: 1,
      completion_minutes: 90,
    });
    expect(result).toHaveProperty("current_streak_days", 7);
    expect(result).toHaveProperty("total_completions", 15);
  });

  it("uses Rust's default Sunday week start for weekly review", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { revision: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await getWeeklyReview();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/planning/weekly");
  });

  it("reads planning, temporal settings, stats, and dopamine menu", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          revision: 1,
          capacity_minutes: 480,
          estimated_total_minutes: 0,
          focus_task_ids: [],
          focus_tasks: [],
          overdue_task_ids: [],
          overdue_tasks: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          capacity_minutes: 480,
          eat_the_frog_enabled: false,
          nudges_enabled: true,
          task_jar_enabled: false,
          time_zone: "UTC",
          week_start: "sunday",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          revision: 2,
          from: "2026-07-17",
          to: "2026-07-23",
          days: [],
          current_streak_days: 0,
          estimate_accuracy_samples: 0,
          total_completion_minutes: 0,
          total_completions: 0,
          total_creations: 0,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { revision: 1, task_ids: [], tasks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getDailyPlan();
    await getTemporalSettings();
    await getStats({ from: "2026-07-17", to: "2026-07-23" });
    await getDopamineMenu();

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/planning/daily");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/v1/settings/temporal");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/v1/stats?from=2026-07-17&to=2026-07-23");
    expect(fetchMock.mock.calls[3]![0]).toBe("/api/v1/motivation/dopamine-menu");
  });

  it("creates time blocks and replans with idempotency keys", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(201, mutationEvent())));
    vi.stubGlobal("fetch", fetchMock);

    await createTimeBlock(
      {
        title: "Deep work",
        date: "2026-07-23",
        start: "09:00",
        end: "10:00",
      },
      "11111111-1111-4111-8111-111111111111",
    );
    await replanTimeBlocks({ action: "move_to_today" }, "22222222-2222-4222-8222-222222222222");
    await appendTimeSlotTask(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      { task_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      "33333333-3333-4333-8333-333333333333",
    );

    const createCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createCall[0]).toBe("/api/v1/time-blocks");
    expect(createCall[1].method).toBe("POST");
    expect(createCall[1].headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(createCall[1].body))).toEqual({
      title: "Deep work",
      date: "2026-07-23",
      start: "09:00",
      end: "10:00",
    });

    expect((fetchMock.mock.calls[1] as [string, RequestInit])[0]).toBe(
      "/api/v1/time-blocks/replan",
    );
    expect((fetchMock.mock.calls[2] as [string, RequestInit])[0]).toBe(
      "/api/v1/time-slots/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/tasks",
    );
  });

  it("lists time blocks by civil range", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { revision: 1, time_blocks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listTimeBlocks({ from: "2026-07-20", to: "2026-07-26" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/time-blocks?from=2026-07-20&to=2026-07-26");
  });

  it("reschedules and dismisses task reminders with idempotency keys", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(200, mutationEvent())));
    vi.stubGlobal("fetch", fetchMock);

    await rescheduleReminder(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { remind_at: "2026-12-15T15:00:00.000Z" },
      "11111111-1111-4111-8111-111111111111",
    );
    await dismissReminder(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "22222222-2222-4222-8222-222222222222",
    );

    const [rescheduleUrl, rescheduleInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(rescheduleUrl).toBe(
      "/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/reminders/reschedule",
    );
    expect(rescheduleInit.headers).toMatchObject({
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
    });
    expect(JSON.parse(String(rescheduleInit.body))).toEqual({
      remind_at: "2026-12-15T15:00:00.000Z",
    });

    const [dismissUrl, dismissInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(dismissUrl).toBe("/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/reminders/dismiss");
    expect(dismissInit.headers).toMatchObject({
      "Idempotency-Key": "22222222-2222-4222-8222-222222222222",
    });
  });

  it("lists reminders and runs control-plane lease/claim/settle without idempotency keys", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { reminders: [] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          fence_term: "fence-1",
          expires_at: "2026-07-23T10:31:30Z",
          updated_at: "2026-07-23T10:30:00Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { reminders: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await listTaskReminders("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await acquireReminderLease({ lease_secs: 90 });
    await claimDueReminders({ fence_term: "fence-1", limit: 20 });
    await settleReminderDelivered({
      fence_term: "fence-1",
      claim_attempt: 1,
      channel: "in_app",
      remind_at: "2026-07-23T10:30:00Z",
      task_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/v1/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/reminders",
    );

    const [, leaseInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(leaseInit.headers).not.toHaveProperty("Idempotency-Key");
    expect(JSON.parse(String(leaseInit.body))).toEqual({ lease_secs: 90 });

    const [, claimInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(claimInit.headers).not.toHaveProperty("Idempotency-Key");

    const [settleUrl, settleInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(settleUrl).toBe("/api/v1/reminders/settle/delivered");
    expect(settleInit.headers).not.toHaveProperty("Idempotency-Key");
  });
});
