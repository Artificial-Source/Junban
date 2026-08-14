/**
 * AI session and message list transport.
 */

import { authenticatedJson } from "../../api/client";
import { resolveOperationId } from "../operation-id";
import type {
  AiMessageListResponse,
  AiSessionDto,
  AiSessionListResponse,
  AiSessionMutationResponse,
  CreateAiSessionHttpRequest,
  ListAiMessagesParams,
  ListAiSessionsParams,
  MutationResponse,
  PatchAiSessionRequest,
} from "../types";
import { toQuery, type AiTransportOptions } from "./core";

export async function listAiSessions(
  params?: ListAiSessionsParams,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiSessionListResponse> {
  return authenticatedJson<AiSessionListResponse>(`/api/v1/ai/sessions${toQuery(params)}`, {
    method: "GET",
    signal: options.signal,
    retryNetwork: false,
  });
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
  return authenticatedJson<AiSessionDto>(`/api/v1/ai/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    signal: options.signal,
    retryNetwork: false,
  });
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
