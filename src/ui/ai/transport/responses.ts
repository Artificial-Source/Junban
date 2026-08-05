/**
 * AI streaming response actions and run cancellation.
 */

import { authenticatedJson } from "../../api/client";
import { resolveOperationId } from "../operation-id";
import type { CancelAiRunResponse, CreateAiResponseRequest, EditAiResponseRequest } from "../types";
import {
  streamAiPost,
  type AiStreamResult,
  type AiStreamTransportOptions,
  type AiTransportOptions,
} from "./core";

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
