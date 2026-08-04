/**
 * AI provider registry, config, and write-only credential transport.
 */

import { authenticatedJson } from "../../api/client";
import { resolveOperationId } from "../operation-id";
import type {
  AiConfigPutRequest,
  AiConfigResponse,
  AiCredentialBindingResponse,
  AiCredentialTargetDto,
  AiProviderPresetDto,
  AiProviderRegistryResponse,
  ModelDiscoveryResponse,
  PutAiCredentialRequest,
} from "../types";
import type { AiTransportOptions } from "./core";

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

export async function deleteAiConfig(options: AiTransportOptions = {}): Promise<AiConfigResponse> {
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
