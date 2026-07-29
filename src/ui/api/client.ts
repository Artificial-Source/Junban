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

/** A network-level error when the server is unreachable or returns non-JSON. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
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

/**
 * Parse and save the URL fragment token, then scrub the fragment.
 * Accepts only `#access_token=...`. Returns true if a token was saved.
 */
export function bootstrapFragmentToken(): boolean {
  const hash = window.location.hash;
  if (!hash) return false;

  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const token = params.get("access_token");
  if (!token) return false;

  storeToken(token);
  // Scrub the fragment before any API call can leak it in a referrer.
  history.replaceState(null, "", window.location.pathname + window.location.search);
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
  if (!token) throw new NetworkError("No access token available");
  return { Authorization: `Bearer ${token}` };
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) return undefined as T;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new NetworkError(`Server returned non-JSON response (status ${response.status})`);
  }
  if (!response.ok) {
    throw new ApiError(body as ErrorEnvelope, response.status);
  }
  return body as T;
}

/** List all tasks. Returns the task array and the current revision. */
export async function listTasks(): Promise<TaskListResponse> {
  const response = await fetch("/api/v1/tasks", {
    headers: { ...authHeaders() },
  });
  return parseResponse<TaskListResponse>(response);
}

/** Create a task with an idempotency key retained across retries. */
export async function createTask(
  body: CreateTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  const response = await fetch("/api/v1/tasks", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "Idempotency-Key": operationId,
    },
    body: JSON.stringify(body),
  });
  return parseResponse<MutationResponse>(response);
}

/** Replace a task (title and nullable due date). */
export async function replaceTask(
  taskId: string,
  body: ReplaceTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  const response = await fetch(`/api/v1/tasks/${taskId}`, {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "Idempotency-Key": operationId,
    },
    body: JSON.stringify(body),
  });
  return parseResponse<MutationResponse>(response);
}

/** Mark a task as completed. */
export async function completeTask(taskId: string, operationId: string): Promise<MutationResponse> {
  const response = await fetch(`/api/v1/tasks/${taskId}/complete`, {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": operationId },
  });
  return parseResponse<MutationResponse>(response);
}

/** Mark a completed task as pending again. */
export async function uncompleteTask(
  taskId: string,
  operationId: string,
): Promise<MutationResponse> {
  const response = await fetch(`/api/v1/tasks/${taskId}/uncomplete`, {
    method: "POST",
    headers: { ...authHeaders(), "Idempotency-Key": operationId },
  });
  return parseResponse<MutationResponse>(response);
}

/** Delete a task. */
export async function deleteTask(taskId: string, operationId: string): Promise<MutationResponse> {
  const response = await fetch(`/api/v1/tasks/${taskId}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "Idempotency-Key": operationId },
  });
  return parseResponse<MutationResponse>(response);
}

/** Check server health (unauthenticated). */
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/health");
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

/**
 * Subscribe to the revisioned SSE event stream using authenticated fetch.
 * Parses incrementally with AbortController. Calls onEvent for each event,
 * reconnects from the last applied revision, and dedupes by revision.
 * Returns a cleanup function that aborts the connection.
 */
export function subscribeToEvents(
  onEvent: (event: SseEvent) => void,
  onReconnect: () => void,
  initialSince: number = 0,
): () => void {
  const controller = new AbortController();
  let lastRevision = initialSince;
  let stopped = false;

  const connect = async () => {
    while (!stopped) {
      try {
        const url = `/api/v1/events?since=${lastRevision}`;
        const response = await fetch(url, {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          // Non-OK: wait and retry
          await delay(2000);
          continue;
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

          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("id:")) {
              currentId = line.slice(3).trim();
            } else if (line.startsWith("data:")) {
              currentData += (currentData ? "\n" : "") + line.slice(5).trim();
            } else if (line === "" && currentData) {
              // Blank line = event boundary
              try {
                const data = JSON.parse(currentData) as TaskEventDto;
                if (data.revision > lastRevision) {
                  lastRevision = data.revision;
                  onEvent({ id: currentId, event: currentEvent, data });
                }
              } catch {
                // Skip malformed event
              }
              currentEvent = "";
              currentId = "";
              currentData = "";
            }
          }
        }

        // Stream ended normally — reconnect from last revision
        if (!stopped) {
          onReconnect();
          await delay(1000);
        }
      } catch {
        if (stopped || controller.signal.aborted) break;
        // Network error or abort — reconnect after delay
        onReconnect();
        await delay(2000);
      }
    }
  };

  void connect();

  return () => {
    stopped = true;
    controller.abort();
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
