/**
 * DTO mapping and error helpers for the conversation lifecycle.
 */

import { ApiError, NetworkError } from "../../api/client";
import type { ChatSessionView, ChatToolProposal } from "../message-view";
import type { AiToolProposalView } from "../types";
import type { ConversationError } from "./types";

export function mapSession(dto: {
  id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message_at?: string | null;
  status: "active" | "archived";
}): ChatSessionView {
  return {
    id: dto.id,
    title: dto.title,
    messageCount: dto.message_count,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
    lastMessageAt: dto.last_message_at ?? null,
    status: dto.status,
  };
}

export function toError(error: unknown): ConversationError {
  if (error instanceof ApiError) {
    return { message: error.message, retryable: error.retryable, code: error.code };
  }
  if (error instanceof NetworkError) {
    if (error.aborted) {
      return { message: "Request cancelled.", retryable: false, code: "aborted" };
    }
    return { message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) {
    return { message: error.message, retryable: false };
  }
  return { message: "Something went wrong.", retryable: false };
}

export function proposalFromStream(view: AiToolProposalView): ChatToolProposal {
  return {
    approvalId: view.approvalId,
    tool: view.tool,
    arguments: view.arguments,
    actionHash: view.actionHash,
    expiresAt: view.expiresAt,
    decision: "pending",
  };
}
