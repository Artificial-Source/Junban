/**
 * Typed Wave 3 AI HTTP transport.
 *
 * Thin wrappers over generated OpenAPI routes. Streaming uses authenticated
 * fetch (never EventSource), retains caller operation ids across same-action
 * retries, and never auto-replays POSTs after ambiguous dispatch.
 */

import {
  ApiError,
  NetworkError,
  authenticatedFetch,
  authenticatedJson,
  parseAuthenticatedResponse,
} from "../api/client";
import { resolveOperationId } from "./operation-id";
import { consumeAiRunSseStream, type AiRunStreamHandlers } from "./sse";
import {
  AiSseError,
  type AiApprovalDecisionRequest,
  type AiApprovalResponse,
  type AiConfigPutRequest,
  type AiConfigResponse,
  type AiCredentialBindingResponse,
  type AiCredentialTargetDto,
  type AiMemoryDto,
  type AiMemoryListResponse,
  type AiMemoryMutationResponse,
  type AiMessageListResponse,
  type AiProviderPresetDto,
  type AiProviderRegistryResponse,
  type AiRunStreamState,
  type AiSessionDto,
  type AiSessionListResponse,
  type AiSessionMutationResponse,
  type CancelAiRunResponse,
  type CreateAiMemoryHttpRequest,
  type CreateAiResponseRequest,
  type CreateAiSessionHttpRequest,
  type EditAiResponseRequest,
  type ListAiMemoriesParams,
  type ListAiMessagesParams,
  type ListAiSessionsParams,
  type ModelDiscoveryResponse,
  type MutationResponse,
  type PatchAiMemoryRequest,
  type PatchAiSessionRequest,
  type PutAiCredentialRequest,
} from "./types";

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

// ---------------------------------------------------------------------------
// Providers / models / config / credentials
// ---------------------------------------------------------------------------

export async function listAiProviders(
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiProviderRegistryResponse> {
  return authenticatedJson<AiProviderRegistryResponse>("/api/v1/ai/providers", {
    method: "GET",
    signal: options.signal,
    retryNetwork: false,
  });
}

export async function discoverAiProviderModels(
  provider: AiProviderPresetDto,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<ModelDiscoveryResponse> {
  return authenticatedJson<ModelDiscoveryResponse>(
    `/api/v1/ai/providers/${encodeURIComponent(provider)}/models`,
    {
      method: "GET",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

export async function getAiConfig(
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiConfigResponse> {
  return authenticatedJson<AiConfigResponse>("/api/v1/ai/config", {
    method: "GET",
    signal: options.signal,
    retryNetwork: false,
  });
}

export async function putAiConfig(
  body: AiConfigPutRequest,
  options: AiTransportOptions = {},
): Promise<AiConfigResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiConfigResponse>("/api/v1/ai/config", {
    method: "PUT",
    operationId,
    body,
    signal: options.signal,
  });
}

export async function deleteAiConfig(
  options: AiTransportOptions = {},
): Promise<AiConfigResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiConfigResponse>("/api/v1/ai/config", {
    method: "DELETE",
    operationId,
    signal: options.signal,
  });
}

/**
 * Write-only credential put. The secret is sent once and never retained by the
 * transport. Callers must not log `body.secret`.
 */
export async function putAiCredential(
  target: AiCredentialTargetDto,
  body: PutAiCredentialRequest,
  options: AiTransportOptions = {},
): Promise<AiCredentialBindingResponse> {
  const operationId = resolveOperationId(options.operationId);
  // Avoid retaining the secret on this stack frame longer than the request.
  const requestBody: PutAiCredentialRequest = {
    kind: body.kind,
    secret: body.secret,
  };
  try {
    return await authenticatedJson<AiCredentialBindingResponse>(
      `/api/v1/ai/credentials/${encodeURIComponent(target)}`,
      {
        method: "PUT",
        operationId,
        body: requestBody,
        signal: options.signal,
      },
    );
  } finally {
    // Best-effort scrub of the local copy (string immutability still applies).
    (requestBody as { secret?: string }).secret = undefined;
  }
}

export async function deleteAiCredential(
  target: AiCredentialTargetDto,
  options: AiTransportOptions = {},
): Promise<AiCredentialBindingResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiCredentialBindingResponse>(
    `/api/v1/ai/credentials/${encodeURIComponent(target)}`,
    {
      method: "DELETE",
      operationId,
      signal: options.signal,
    },
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function listAiSessions(
  params?: ListAiSessionsParams,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiSessionListResponse> {
  return authenticatedJson<AiSessionListResponse>(
    `/api/v1/ai/sessions${toQuery(params)}`,
    {
      method: "GET",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

export async function createAiSession(
  body: CreateAiSessionHttpRequest,
  options: AiTransportOptions = {},
): Promise<AiSessionMutationResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiSessionMutationResponse>("/api/v1/ai/sessions", {
    method: "POST",
    operationId,
    body,
    signal: options.signal,
  });
}

export async function getAiSession(
  sessionId: string,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiSessionDto> {
  return authenticatedJson<AiSessionDto>(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

export async function updateAiSession(
  sessionId: string,
  body: PatchAiSessionRequest,
  options: AiTransportOptions = {},
): Promise<AiSessionMutationResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiSessionMutationResponse>(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      operationId,
      body,
      signal: options.signal,
    },
  );
}

export async function deleteAiSession(
  sessionId: string,
  options: AiTransportOptions = {},
): Promise<MutationResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<MutationResponse>(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      operationId,
      signal: options.signal,
    },
  );
}

export async function clearAiSession(
  sessionId: string,
  options: AiTransportOptions = {},
): Promise<AiSessionMutationResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiSessionMutationResponse>(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/clear`,
    {
      method: "POST",
      operationId,
      signal: options.signal,
    },
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listAiMessages(
  sessionId: string,
  params?: ListAiMessagesParams,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiMessageListResponse> {
  return authenticatedJson<AiMessageListResponse>(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/messages${toQuery(params)}`,
    {
      method: "GET",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

/**
 * Load one message by id from the session list (no dedicated GET route).
 * Returns null when the message is not present in the fetched page window.
 */
export async function getAiMessage(
  sessionId: string,
  messageId: string,
  options: Pick<AiTransportOptions, "signal"> & {
    /** Optional list window; defaults to a full page. */
    params?: ListAiMessagesParams;
  } = {},
): Promise<AiMessageListResponse["messages"][number] | null> {
  const listed = await listAiMessages(sessionId, options.params, options);
  return listed.messages.find((message) => message.id === messageId) ?? null;
}

// ---------------------------------------------------------------------------
// Streaming responses (create / edit / retry / regenerate / daily briefing)
// ---------------------------------------------------------------------------

export async function createAiResponse(
  sessionId: string,
  body: CreateAiResponseRequest,
  options: AiStreamTransportOptions = {},
): Promise<AiStreamResult> {
  const operationId = resolveOperationId(options.operationId);
  return streamAiPost(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/responses`,
    body,
    operationId,
    options,
  );
}

export async function createAiDailyBriefing(
  sessionId: string,
  options: AiStreamTransportOptions = {},
): Promise<AiStreamResult> {
  const operationId = resolveOperationId(options.operationId);
  return streamAiPost(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/daily-briefing`,
    {},
    operationId,
    options,
  );
}

export async function editAiResponse(
  sessionId: string,
  messageId: string,
  body: EditAiResponseRequest,
  options: AiStreamTransportOptions = {},
): Promise<AiStreamResult> {
  const operationId = resolveOperationId(options.operationId);
  return streamAiPost(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/edit`,
    body,
    operationId,
    options,
  );
}

export async function retryAiResponse(
  sessionId: string,
  messageId: string,
  options: AiStreamTransportOptions = {},
): Promise<AiStreamResult> {
  const operationId = resolveOperationId(options.operationId);
  return streamAiPost(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/retry`,
    {},
    operationId,
    options,
  );
}

export async function regenerateAiResponse(
  sessionId: string,
  messageId: string,
  options: AiStreamTransportOptions = {},
): Promise<AiStreamResult> {
  const operationId = resolveOperationId(options.operationId);
  return streamAiPost(
    `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/regenerate`,
    {},
    operationId,
    options,
  );
}

export async function cancelAiRun(
  runId: string,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<CancelAiRunResponse> {
  // Control-plane cancel: no Idempotency-Key per OpenAPI.
  return authenticatedJson<CancelAiRunResponse>(
    `/api/v1/ai/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

export async function listAiMemories(
  params?: ListAiMemoriesParams,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiMemoryListResponse> {
  return authenticatedJson<AiMemoryListResponse>(
    `/api/v1/ai/memories${toQuery(params)}`,
    {
      method: "GET",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

export async function createAiMemory(
  body: CreateAiMemoryHttpRequest,
  options: AiTransportOptions = {},
): Promise<AiMemoryMutationResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiMemoryMutationResponse>("/api/v1/ai/memories", {
    method: "POST",
    operationId,
    body,
    signal: options.signal,
  });
}

export async function getAiMemory(
  memoryId: string,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiMemoryDto> {
  return authenticatedJson<AiMemoryDto>(
    `/api/v1/ai/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "GET",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

export async function updateAiMemory(
  memoryId: string,
  body: PatchAiMemoryRequest,
  options: AiTransportOptions = {},
): Promise<AiMemoryMutationResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiMemoryMutationResponse>(
    `/api/v1/ai/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "PATCH",
      operationId,
      body,
      signal: options.signal,
    },
  );
}

export async function deleteAiMemory(
  memoryId: string,
  options: AiTransportOptions = {},
): Promise<MutationResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<MutationResponse>(
    `/api/v1/ai/memories/${encodeURIComponent(memoryId)}`,
    {
      method: "DELETE",
      operationId,
      signal: options.signal,
    },
  );
}

// ---------------------------------------------------------------------------
// Approvals (contract routes: get / approve / reject — no list route)
// ---------------------------------------------------------------------------

export async function getAiApproval(
  approvalId: string,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiApprovalResponse> {
  return authenticatedJson<AiApprovalResponse>(
    `/api/v1/ai/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "GET",
      signal: options.signal,
      retryNetwork: false,
    },
  );
}

export async function approveAiApproval(
  approvalId: string,
  body: AiApprovalDecisionRequest,
  options: AiTransportOptions = {},
): Promise<AiApprovalResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiApprovalResponse>(
    `/api/v1/ai/approvals/${encodeURIComponent(approvalId)}/approve`,
    {
      method: "POST",
      operationId,
      body,
      signal: options.signal,
    },
  );
}

export async function rejectAiApproval(
  approvalId: string,
  body: AiApprovalDecisionRequest,
  options: AiTransportOptions = {},
): Promise<AiApprovalResponse> {
  const operationId = resolveOperationId(options.operationId);
  return authenticatedJson<AiApprovalResponse>(
    `/api/v1/ai/approvals/${encodeURIComponent(approvalId)}/reject`,
    {
      method: "POST",
      operationId,
      body,
      signal: options.signal,
    },
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function streamAiPost(
  path: string,
  body: unknown,
  operationId: string,
  options: AiStreamTransportOptions,
): Promise<AiStreamResult> {
  // Never retry streaming POSTs — ambiguous dispatch must not auto-replay.
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

function toQuery(
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

/**
 * Ensure transport errors never embed bearer tokens or raw credential secrets.
 * ApiError/NetworkError/AiSseError messages are already contract-safe; this
 * guards unexpected DOMException/TypeError strings from fetch.
 */
export function sanitizeTransportError(error: unknown): Error {
  if (
    error instanceof AiSseError ||
    error instanceof ApiError ||
    error instanceof NetworkError
  ) {
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
