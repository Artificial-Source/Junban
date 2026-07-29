/**
 * Browser-only API facade using checked generated.ts types.
 * Components never know transport details; this is the only fetch boundary.
 */

import type { components } from "../api/generated";

type TaskDto = components["schemas"]["TaskDto"];
type TaskListResponse = components["schemas"]["TaskListResponse"];
type CreateTaskRequest = components["schemas"]["CreateTaskRequest"];
type ReplaceTaskRequest = components["schemas"]["ReplaceTaskRequest"];
type MutationResponse = components["schemas"]["MutationResponse"];
type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
type TaskEventDto = components["schemas"]["TaskEventDto"];

export type {
  TaskDto,
  TaskListResponse,
  CreateTaskRequest,
  ReplaceTaskRequest,
  MutationResponse,
  ErrorEnvelope,
  TaskEventDto,
};

/** A typed API error with the server's error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly fields: Record<string, string> | null;

  constructor(envelope: ErrorEnvelope, status: number) {
    super(envelope.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = envelope.error.code;
    this.retryable = envelope.error.retryable;
    this.requestId = envelope.request_id;
    this.fields = envelope.error.fields ?? null;
  }
}

/** A network-level error when the server is unreachable or returns an invalid response. */
export class NetworkError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = "NetworkError";
    this.retryable = retryable;
  }
}

const TOKEN_STORAGE_KEY = "junban-access-token";

/** Read the bearer token from sessionStorage. Returns null if absent. */
export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Save the bearer token to sessionStorage. */
export function storeToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

/** Remove the bearer token from sessionStorage. */
export function clearStoredToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Check whether a token is present (without exposing it). */
export function hasStoredToken(): boolean {
  return getStoredToken() !== null;
}

function decodeFragmentToken(fragment: string): string | null {
  const prefix = "access_token=";
  if (!fragment.startsWith(prefix)) return null;

  const encodedToken = fragment.slice(prefix.length);
  if (!encodedToken || encodedToken.includes("&")) return null;

  try {
    const token = decodeURIComponent(encodedToken.replace(/\+/g, " "));
    return token ? token : null;
  } catch {
    return null;
  }
}

/**
 * Parse and save an exact URL-fragment token, then scrub all token-bearing URL parts.
 * Query-string tokens are deliberately discarded and never used for authentication.
 */
export function bootstrapFragmentToken(): boolean {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const token = decodeFragmentToken(fragment);
  const query = new URLSearchParams(window.location.search);
  const hadQueryToken = query.has("access_token");
  query.delete("access_token");

  if (window.location.hash || hadQueryToken) {
    const search = query.toString();
    history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }

  if (!token) return false;
  storeToken(token);
  return true;
}

/** Generate a UUID v4 idempotency key for one logical operation. */
export function generateOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older browsers.
  return "00000000-0000-4000-8000-000000000000".replace(/0/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  if (!token) throw new NetworkError("No access token available", false);
  return { Authorization: `Bearer ${token}` };
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new NetworkError("Network request failed");
  }
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (!body || typeof body !== "object") return false;
  const envelope = body as Record<string, unknown>;
  if (
    typeof envelope.request_id !== "string" ||
    !envelope.error ||
    typeof envelope.error !== "object"
  ) {
    return false;
  }
  const error = envelope.error as Record<string, unknown>;
  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new NetworkError("Could not read the server response", response.ok);
  }
  if (!text) {
    throw new NetworkError(
      `Server returned an empty response (status ${response.status})`,
      response.ok,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new NetworkError(
      `Server returned non-JSON response (status ${response.status})`,
      response.ok,
    );
  }
  if (!response.ok) {
    if (!isErrorEnvelope(body)) {
      throw new NetworkError(
        `Server returned an invalid error response (status ${response.status})`,
        false,
      );
    }
    throw new ApiError(body, response.status);
  }
  return body as T;
}

async function mutate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof NetworkError) || !error.retryable) throw error;
    return operation();
  }
}

/** List all tasks. Returns the task array and the current revision. */
export async function listTasks(): Promise<TaskListResponse> {
  const response = await request("/api/v1/tasks", { headers: { ...authHeaders() } });
  return parseResponse<TaskListResponse>(response);
}

/** Create a task with an idempotency key retained across one transport retry. */
export async function createTask(
  body: CreateTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  return mutate(async () => {
    const response = await request("/api/v1/tasks", {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        "Idempotency-Key": operationId,
      },
      body: JSON.stringify(body),
    });
    return parseResponse<MutationResponse>(response);
  });
}

/** Replace a task (title and nullable due date). */
export async function replaceTask(
  taskId: string,
  body: ReplaceTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  return mutate(async () => {
    const response = await request(`/api/v1/tasks/${taskId}`, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        "Idempotency-Key": operationId,
      },
      body: JSON.stringify(body),
    });
    return parseResponse<MutationResponse>(response);
  });
}

/** Mark a task as completed. */
export async function completeTask(taskId: string, operationId: string): Promise<MutationResponse> {
  return mutate(async () => {
    const response = await request(`/api/v1/tasks/${taskId}/complete`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": operationId },
    });
    return parseResponse<MutationResponse>(response);
  });
}

/** Mark a completed task as pending again. */
export async function uncompleteTask(
  taskId: string,
  operationId: string,
): Promise<MutationResponse> {
  return mutate(async () => {
    const response = await request(`/api/v1/tasks/${taskId}/uncomplete`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": operationId },
    });
    return parseResponse<MutationResponse>(response);
  });
}

/** Delete a task. */
export async function deleteTask(taskId: string, operationId: string): Promise<MutationResponse> {
  return mutate(async () => {
    const response = await request(`/api/v1/tasks/${taskId}`, {
      method: "DELETE",
      headers: { ...authHeaders(), "Idempotency-Key": operationId },
    });
    return parseResponse<MutationResponse>(response);
  });
}

/** Check server health (unauthenticated). */
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await request("/api/v1/health");
    return response.ok;
  } catch {
    return false;
  }
}

/** SSE event parsed from the incremental fetch stream. */
export interface SseEvent {
  id: string;
  event: string;
  data: TaskEventDto;
}

export type SseTerminalError = {
  kind: "authentication" | "protocol";
  message: string;
};

function isTaskEvent(data: unknown): data is TaskEventDto {
  if (!data || typeof data !== "object") return false;
  const event = data as Record<string, unknown>;
  return (
    typeof event.revision === "number" &&
    typeof event.operation_id === "string" &&
    typeof event.task_id === "string" &&
    typeof event.event_type === "string"
  );
}

function reconnectDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, ms);
    const onAbort = () => {
      window.clearTimeout(timeout);
      done();
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Subscribe to the revisioned SSE event stream using authenticated fetch.
 * Transport failures reconnect from the last revision. Authentication and protocol
 * failures are terminal so a rejected stream cannot retry forever.
 */
export function subscribeToEvents(
  onEvent: (event: SseEvent) => void,
  onReconnect: () => void,
  onTerminal: (error: SseTerminalError) => void,
  initialSince: number = 0,
): () => void {
  const controller = new AbortController();
  let lastRevision = initialSince;
  let stopped = false;

  const stopWithError = (error: SseTerminalError) => {
    if (stopped) return;
    stopped = true;
    onTerminal(error);
    controller.abort();
  };

  const connect = async () => {
    while (!stopped) {
      try {
        const response = await request(`/api/v1/events?since=${lastRevision}`, {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          stopWithError({ kind: "authentication", message: "Event stream authentication failed." });
          return;
        }
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          stopWithError({
            kind: "protocol",
            message: "Event stream returned an invalid response.",
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";
        let currentId = "";
        let currentData = "";

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("id:")) {
              currentId = line.slice(3).trim();
            } else if (line.startsWith("data:")) {
              currentData += (currentData ? "\n" : "") + line.slice(5).trim();
            } else if (line === "" && currentData) {
              let data: unknown;
              try {
                data = JSON.parse(currentData);
              } catch {
                stopWithError({
                  kind: "protocol",
                  message: "Event stream contained invalid JSON.",
                });
                return;
              }
              if (!isTaskEvent(data)) {
                stopWithError({
                  kind: "protocol",
                  message: "Event stream contained an invalid event.",
                });
                return;
              }
              if (data.revision > lastRevision) {
                lastRevision = data.revision;
                onEvent({ id: currentId, event: currentEvent, data });
              }
              currentEvent = "";
              currentId = "";
              currentData = "";
            }
          }
        }

        if (!stopped) {
          onReconnect();
          await reconnectDelay(1000, controller.signal);
        }
      } catch {
        if (stopped || controller.signal.aborted) break;
        onReconnect();
        await reconnectDelay(2000, controller.signal);
      }
    }
  };

  void connect();

  return () => {
    stopped = true;
    controller.abort();
  };
}
