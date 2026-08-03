/**
 * Approval card bound to exact streamed/durable approval_id + action_hash.
 */
import { memo } from "react";
import { Check, X } from "lucide-react";
import type { ChatToolProposal } from "../message-view";
import { formatStructuredPlain, toolMetaFor } from "../tool-meta";

export const ToolProposalCard = memo(function ToolProposalCard({
  proposal,
  onApprove,
  onReject,
  disabled,
}: {
  proposal: ChatToolProposal;
  onApprove?: (approvalId: string, actionHash: string) => void;
  onReject?: (approvalId: string, actionHash: string) => void;
  disabled?: boolean;
}) {
  const meta = toolMetaFor(proposal.tool);
  const Icon = meta.icon;
  const pending = proposal.decision === "pending";
  const busy = Boolean(proposal.decisionPending) || disabled;

  return (
    <div
      className="rounded-xl border border-border bg-surface shadow-sm overflow-hidden"
      data-approval-id={proposal.approvalId}
      data-action-hash={proposal.actionHash}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-secondary/50 border-b border-border/50">
        <div className="w-5 h-5 rounded-md bg-accent-action/10 flex items-center justify-center">
          <Icon size={11} className="text-accent-foreground" aria-hidden="true" />
        </div>
        <span className="text-xs font-medium text-on-surface-secondary">
          Approve {proposal.tool.replace(/_/g, " ")}
        </span>
        {!pending && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-on-surface-muted">
            {proposal.decision}
          </span>
        )}
      </div>
      <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-on-surface-secondary max-h-40 overflow-auto">
        {formatStructuredPlain(proposal.arguments, 2_000)}
      </pre>
      {pending && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
          <button
            type="button"
            disabled={busy || !onApprove}
            onClick={() => onApprove?.(proposal.approvalId, proposal.actionHash)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-accent-action text-on-accent-action hover:bg-accent-action-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Check size={12} aria-hidden="true" />
            Approve
          </button>
          <button
            type="button"
            disabled={busy || !onReject}
            onClick={() => onReject?.(proposal.approvalId, proposal.actionHash)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-on-surface-secondary hover:bg-surface-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <X size={12} aria-hidden="true" />
            Reject
          </button>
        </div>
      )}
    </div>
  );
});
