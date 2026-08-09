/**
 * Shared conversation lifecycle types (Wave 4d).
 */

import type { RetainedOperationId } from "../operation-id";
import type { ConversationTransport } from "../conversation-transport";
import type { ChatMessageView, ChatSessionView, ChatToolProposal } from "../message-view";

/** Domain AI_USER_INPUT_BYTES_MAX. */
export const AI_USER_INPUT_BYTES_MAX = 32 * 1024;

export type ConversationError = {
  message: string;
  retryable: boolean;
  code?: string;
};

export type UseAiConversationOptions = {
  transport?: ConversationTransport;
  /** Focused task id included on create/edit/retry/regenerate. */
  focusedTaskId?: string | null;
  /** When true, hook is active and loads session history. */
  enabled?: boolean;
};

export type UseAiConversationResult = {
  sessions: ChatSessionView[];
  sessionsLoading: boolean;
  sessionsCursor: string | null;
  activeSessionId: string | null;
  messages: ChatMessageView[];
  messagesLoading: boolean;
  isStreaming: boolean;
  reasoningStatus: string | null;
  runId: string | null;
  error: ConversationError | null;
  /** Pending streamed proposals not yet folded into messages. */
  liveProposals: ChatToolProposal[];
  composerPrefill: string;
  setComposerPrefill: (value: string) => void;
  loadMoreSessions: () => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createNewSession: () => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  clearSession: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  sendDailyBriefing: () => Promise<void>;
  editAndResend: (messageId: string, text: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  stop: () => Promise<void>;
  approveProposal: (approvalId: string, actionHash: string) => Promise<void>;
  rejectProposal: (approvalId: string, actionHash: string) => Promise<void>;
  dismissError: () => void;
};

export type StreamActionKind = "send" | "edit" | "retry" | "regenerate" | "briefing";

export type ActiveRun = {
  runGeneration: number;
  sessionId: string;
  controller: AbortController;
  operation: RetainedOperationId;
  /** Canonical action identity key for retention. */
  actionKey: string;
  runId: string | null;
  kind: StreamActionKind;
  /** Message id for edit/retry/regenerate. */
  messageId?: string;
};
