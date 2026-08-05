/**
 * Approval decide mutations with identity-keyed operation retention.
 */

import { useCallback } from "react";
import { ActionKeys } from "./operations";
import { toError } from "./helpers";
import type { ConversationShared } from "./shared";

export type AiApprovalsApi = {
  approveProposal: (approvalId: string, actionHash: string) => Promise<void>;
  rejectProposal: (approvalId: string, actionHash: string) => Promise<void>;
};

export function useAiApprovals(shared: ConversationShared): AiApprovalsApi {
  const {
    transport,
    ops,
    setLiveProposals,
    setMessages,
    setError,
    surfaceGenRef,
    sessionGenRef,
    activeSessionIdRef,
    isCurrentSurface,
    reloadMessages,
  } = shared;

  const markPending = useCallback(
    (approvalId: string, pending: boolean) => {
      setLiveProposals((prev) =>
        prev.map((p) => (p.approvalId === approvalId ? { ...p, decisionPending: pending } : p)),
      );
      setMessages((prev) =>
        prev.map((m) => ({
          ...m,
          proposals: m.proposals.map((p) =>
            p.approvalId === approvalId ? { ...p, decisionPending: pending } : p,
          ),
          segments: m.segments.map((s) =>
            s.kind === "tool_proposed" && s.proposal.approvalId === approvalId
              ? {
                  ...s,
                  proposal: { ...s.proposal, decisionPending: pending },
                }
              : s,
          ),
        })),
      );
    },
    [setLiveProposals, setMessages],
  );

  const approveProposal = useCallback(
    async (approvalId: string, actionHash: string) => {
      const surfaceGen = surfaceGenRef.current;
      const sessionId = activeSessionIdRef.current;
      const key = ActionKeys.approve(approvalId, actionHash);
      const op = ops.retain(key);

      markPending(approvalId, true);

      try {
        await transport.approveApproval(
          approvalId,
          { action_hash: actionHash },
          { operationId: op.id },
        );
        if (!isCurrentSurface(surfaceGen)) return;
        ops.release(key);
        if (sessionId) {
          await reloadMessages(sessionId, sessionGenRef.current, surfaceGen);
        }
        try {
          await transport.getApproval(approvalId);
        } catch {
          // Listing approval after decision is best-effort confirmation.
        }
      } catch (err) {
        if (!isCurrentSurface(surfaceGen)) return;
        setError(toError(err));
        markPending(approvalId, false);
      }
    },
    [
      activeSessionIdRef,
      isCurrentSurface,
      markPending,
      ops,
      reloadMessages,
      sessionGenRef,
      setError,
      surfaceGenRef,
      transport,
    ],
  );

  const rejectProposal = useCallback(
    async (approvalId: string, actionHash: string) => {
      const surfaceGen = surfaceGenRef.current;
      const sessionId = activeSessionIdRef.current;
      const key = ActionKeys.reject(approvalId, actionHash);
      const op = ops.retain(key);

      setLiveProposals((prev) =>
        prev.map((p) => (p.approvalId === approvalId ? { ...p, decisionPending: true } : p)),
      );

      try {
        await transport.rejectApproval(
          approvalId,
          { action_hash: actionHash },
          { operationId: op.id },
        );
        if (!isCurrentSurface(surfaceGen)) return;
        ops.release(key);
        if (sessionId) {
          await reloadMessages(sessionId, sessionGenRef.current, surfaceGen);
        }
      } catch (err) {
        if (!isCurrentSurface(surfaceGen)) return;
        setError(toError(err));
        setLiveProposals((prev) =>
          prev.map((p) => (p.approvalId === approvalId ? { ...p, decisionPending: false } : p)),
        );
      }
    },
    [
      activeSessionIdRef,
      isCurrentSurface,
      ops,
      reloadMessages,
      sessionGenRef,
      setError,
      setLiveProposals,
      surfaceGenRef,
      transport,
    ],
  );

  return { approveProposal, rejectProposal };
}
