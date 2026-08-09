/**
 * Session/message/run lifecycle for the AI chat surface.
 *
 * Thin composition facade over feature-local owners:
 * - `conversation/shared` — generations, paging reload, retained ops bag
 * - `conversation/useAiSessions` — session list/mutations + deferred create
 * - `conversation/useAiRun` — streaming send/edit/retry/regenerate/stop
 * - `conversation/useAiApprovals` — approve/reject decisions
 * - `conversation/operations` — identity-keyed operation retention
 *
 * Owns AbortController generations so stale callbacks never mutate state.
 * Creates a session only on the first concrete send/briefing action.
 * One operation UUID per logical action identity; never auto-replays POSTs.
 */

import { useCallback } from "react";
import { useConversationShared } from "./conversation/shared";
import { useAiSessions } from "./conversation/useAiSessions";
import { useAiRun } from "./conversation/useAiRun";
import { useAiApprovals } from "./conversation/useAiApprovals";
import type { UseAiConversationOptions, UseAiConversationResult } from "./conversation/types";

export { AI_USER_INPUT_BYTES_MAX } from "./conversation/types";
export type {
  ConversationError,
  UseAiConversationOptions,
  UseAiConversationResult,
} from "./conversation/types";

export function useAiConversation(options: UseAiConversationOptions = {}): UseAiConversationResult {
  const shared = useConversationShared(options);
  const sessions = useAiSessions(shared);
  const run = useAiRun(shared, sessions.ensureSession);
  const approvals = useAiApprovals(shared);

  const { error, setError, composerPrefill, setComposerPrefill } = shared;
  const dismissError = useCallback(() => setError(null), [setError]);

  return {
    sessions: sessions.sessions,
    sessionsLoading: sessions.sessionsLoading,
    sessionsCursor: sessions.sessionsCursor,
    activeSessionId: sessions.activeSessionId,
    messages: run.messages,
    messagesLoading: sessions.messagesLoading,
    isStreaming: run.isStreaming,
    reasoningStatus: run.reasoningStatus,
    runId: run.runId,
    error,
    liveProposals: run.liveProposals,
    composerPrefill,
    setComposerPrefill,
    loadMoreSessions: sessions.loadMoreSessions,
    selectSession: sessions.selectSession,
    createNewSession: sessions.createNewSession,
    renameSession: sessions.renameSession,
    deleteSession: sessions.deleteSession,
    clearSession: sessions.clearSession,
    sendMessage: run.sendMessage,
    sendDailyBriefing: run.sendDailyBriefing,
    editAndResend: run.editAndResend,
    retryMessage: run.retryMessage,
    regenerateMessage: run.regenerateMessage,
    stop: run.stop,
    approveProposal: approvals.approveProposal,
    rejectProposal: approvals.rejectProposal,
    dismissError,
  };
}
