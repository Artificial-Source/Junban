import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  NetworkError,
  bootstrapFragmentToken,
  clearStoredToken,
  createTask,
  generateOperationId,
  getStoredToken,
  hasStoredToken,
  storeToken,
  subscribeToEvents,
} from "./client";

function setLocation(hash: string, search = "") {
  vi.stubGlobal("location", {
    hash,
    pathname: "/today",
    search,
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

  it("retries one transport failure with the same idempotency key", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(errorResponse(201, {}));
    vi.stubGlobal("fetch", fetchMock);

    await createTask(
      { title: "Retry task", due_date: null },
      "11111111-1111-4111-8111-111111111111",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({
        "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
      });
    }
  });

  it("does not retry an HTTP error envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(422, {
        request_id: "request-id",
        error: {
          code: "validation_error",
          message: "Title is invalid",
          retryable: false,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createTask({ title: "", due_date: null }, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns malformed HTTP errors into NetworkError without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("broken", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createTask({ title: "Task", due_date: null }, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("event stream lifecycle", () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeToken("test-token");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("surfaces terminal authentication failures without reconnecting", async () => {
    const onReconnect = vi.fn();
    const onTerminal = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errorResponse(401, { error: "not used by stream parsing" })),
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
});
