/**
 * AI memory CRUD transport.
 */

import { authenticatedJson } from "../../api/client";
import { resolveOperationId } from "../operation-id";
import type {
  AiMemoryDto,
  AiMemoryListResponse,
  AiMemoryMutationResponse,
  CreateAiMemoryHttpRequest,
  ListAiMemoriesParams,
  MutationResponse,
  PatchAiMemoryRequest,
} from "../types";
import { toQuery, type AiTransportOptions } from "./core";

export async function listAiMemories(
  params?: ListAiMemoriesParams,
  options: Pick<AiTransportOptions, "signal"> = {},
): Promise<AiMemoryListResponse> {
  return authenticatedJson<AiMemoryListResponse>(`/api/v1/ai/memories${toQuery(params)}`, {
    method: "GET",
    signal: options.signal,
    retryNetwork: false,
  });
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
  return authenticatedJson<AiMemoryDto>(`/api/v1/ai/memories/${encodeURIComponent(memoryId)}`, {
    method: "GET",
    signal: options.signal,
    retryNetwork: false,
  });
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
