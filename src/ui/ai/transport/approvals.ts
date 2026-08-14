/**
 * AI approval get / approve / reject transport (no list route in contract).
 */

import { authenticatedJson } from "../../api/client";
import { resolveOperationId } from "../operation-id";
import type { AiApprovalDecisionRequest, AiApprovalResponse } from "../types";
import type { AiTransportOptions } from "./core";

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
