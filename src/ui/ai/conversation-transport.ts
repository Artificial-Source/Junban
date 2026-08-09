/**
 * Narrow transport surface for useAiConversation.
 * Defaults to Wave 4b modules; tests inject deterministic fakes.
 */

import {
  approveAiApproval,
  cancelAiRun,
  clearAiSession,
  createAiDailyBriefing,
  createAiResponse,
  createAiSession,
  deleteAiSession,
  editAiResponse,
  getAiApproval,
  listAiMessages,
  listAiSessions,
  regenerateAiResponse,
  rejectAiApproval,
  retryAiResponse,
  updateAiSession,
  type AiStreamResult,
  type AiStreamTransportOptions,
  type AiTransportOptions,
} from "./transport";
import type {
  AiApprovalDecisionRequest,
  AiApprovalResponse,
  AiMessageListResponse,
  AiSessionListResponse,
  AiSessionMutationResponse,
  CancelAiRunResponse,
  CreateAiResponseRequest,
  CreateAiSessionHttpRequest,
  EditAiResponseRequest,
  ListAiMessagesParams,
  ListAiSessionsParams,
  MutationResponse,
  PatchAiSessionRequest,
} from "./types";

export type ConversationTransport = {
  listSessions: (
    params?: ListAiSessionsParams,
    options?: Pick<AiTransportOptions, "signal">,
  ) => Promise<AiSessionListResponse>;
  createSession: (
    body: CreateAiSessionHttpRequest,
    options?: AiTransportOptions,
  ) => Promise<AiSessionMutationResponse>;
  updateSession: (
    sessionId: string,
    body: PatchAiSessionRequest,
    options?: AiTransportOptions,
  ) => Promise<AiSessionMutationResponse>;
  deleteSession: (sessionId: string, options?: AiTransportOptions) => Promise<MutationResponse>;
  clearSession: (
    sessionId: string,
    options?: AiTransportOptions,
  ) => Promise<AiSessionMutationResponse>;
  listMessages: (
    sessionId: string,
    params?: ListAiMessagesParams,
    options?: Pick<AiTransportOptions, "signal">,
  ) => Promise<AiMessageListResponse>;
  createResponse: (
    sessionId: string,
    body: CreateAiResponseRequest,
    options?: AiStreamTransportOptions,
  ) => Promise<AiStreamResult>;
  createDailyBriefing: (
    sessionId: string,
    options?: AiStreamTransportOptions,
  ) => Promise<AiStreamResult>;
  editResponse: (
    sessionId: string,
    messageId: string,
    body: EditAiResponseRequest,
    options?: AiStreamTransportOptions,
  ) => Promise<AiStreamResult>;
  retryResponse: (
    sessionId: string,
    messageId: string,
    options?: AiStreamTransportOptions,
  ) => Promise<AiStreamResult>;
  regenerateResponse: (
    sessionId: string,
    messageId: string,
    options?: AiStreamTransportOptions,
  ) => Promise<AiStreamResult>;
  cancelRun: (
    runId: string,
    options?: Pick<AiTransportOptions, "signal">,
  ) => Promise<CancelAiRunResponse>;
  getApproval: (
    approvalId: string,
    options?: Pick<AiTransportOptions, "signal">,
  ) => Promise<AiApprovalResponse>;
  approveApproval: (
    approvalId: string,
    body: AiApprovalDecisionRequest,
    options?: AiTransportOptions,
  ) => Promise<AiApprovalResponse>;
  rejectApproval: (
    approvalId: string,
    body: AiApprovalDecisionRequest,
    options?: AiTransportOptions,
  ) => Promise<AiApprovalResponse>;
};

export const defaultConversationTransport: ConversationTransport = {
  listSessions: listAiSessions,
  createSession: createAiSession,
  updateSession: updateAiSession,
  deleteSession: deleteAiSession,
  clearSession: clearAiSession,
  listMessages: listAiMessages,
  createResponse: createAiResponse,
  createDailyBriefing: createAiDailyBriefing,
  editResponse: editAiResponse,
  retryResponse: retryAiResponse,
  regenerateResponse: regenerateAiResponse,
  cancelRun: cancelAiRun,
  getApproval: getAiApproval,
  approveApproval: approveAiApproval,
  rejectApproval: rejectAiApproval,
};
