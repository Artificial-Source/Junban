/**
 * Shared AI transport core: options, query encoding, streaming POST, sanitization.
 */

import {
  ApiError,
  NetworkError,
  authenticatedFetch,
  parseAuthenticatedResponse,
} from "../../api/client";
import { consumeAiRunSseStream, type AiRunStreamHandlers } from "../sse";
import {
  AiSseError,
  type AiRunStreamState,
  type ListAiMemoriesParams,
  type ListAiMessagesParams,
  type ListAiSessionsParams,
} from "../types";

export type AiTransportOptions = {
  /** Retained Idempotency-Key for this logical mutation. */
  operationId?: string;
  signal?: AbortSignal;
};

export type AiStreamTransportOptions = AiTransportOptions & {
  handlers?: AiRunStreamHandlers;
};

export type AiStreamResult = {
  operationId: string;
  state: AiRunStreamState;
};

export function toQuery(
  params:
    | ListAiSessionsParams
    | ListAiMemoriesParams
    | ListAiMessagesParams
    | Record<string, string | number | boolean | null | undefined>
    | undefined,
): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Streaming AI POST: never auto-retries after ambiguous dispatch. */
export async function streamAiPost(
  path: string,
  body: unknown,
  operationId: string,
  options: AiStreamTransportOptions,
): Promise<AiStreamResult> {
  const response = await authenticatedFetch(path, {
    method: "POST",
    operationId,
    body,
    signal: options.signal,
    timeoutMs: null,
    retryNetwork: false,
  });

  if (!response.ok) {
    await parseAuthenticatedResponse(response);
    // parseAuthenticatedResponse always throws on !ok; keep the type checker happy.
    throw new NetworkError("AI stream request failed", false);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    throw new AiSseError("protocol", "AI stream returned a non-event-stream response");
  }

  try {
    const state = await consumeAiRunSseStream(response.body, {
      signal: options.signal,
      handlers: options.handlers,
    });
    return { operationId, state };
  } catch (error) {
    // Scrub any accidental secret/token material from unexpected error strings.
    throw sanitizeTransportError(error);
  }
}

/**
 * Ensure transport errors never embed bearer tokens or raw credential secrets.
 * ApiError/NetworkError/AiSseError messages are already contract-safe; this
 * guards unexpected DOMException/TypeError strings from fetch.
 */
export function sanitizeTransportError(error: unknown): Error {
  if (error instanceof AiSseError || error instanceof ApiError || error instanceof NetworkError) {
    return error;
  }
  if (error instanceof Error) {
    const message = redactSensitive(error.message);
    const safe = new NetworkError(message, false, /abort/i.test(error.name));
    safe.name = error.name === "AbortError" ? "NetworkError" : "NetworkError";
    return safe;
  }
  return new NetworkError("AI transport failed", false);
}

function redactSensitive(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/("secret"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/(secret["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[redacted]");
}
