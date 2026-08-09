/**
 * Approval card bound to exact streamed/durable approval_id + action_hash.
 */
import { memo } from "react";
import { Check, X } from "lucide-react";
import type { ChatToolProposal } from "../message-view";
import {
  APPLY_AUTO_SCHEDULE_DAY_TOOL,
  formatStructuredPlain,
  toolDisplayLabel,
  toolMetaFor,
} from "../tool-meta";

function presentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Complete exact canonical args — no char/item/field truncation before approval. */
function formatCompleteArgsPlain(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function GenericArgsPlain({ args }: { args: unknown }) {
  return (
    <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-on-surface-secondary max-h-40 overflow-auto">
      {formatCompleteArgsPlain(args)}
    </pre>
  );
}

function ScheduleBlockItem({ block, index }: { block: unknown; index: number }) {
  const rec = asRecord(block);
  if (!rec) {
    return (
      <li className="rounded-md border border-border/40 px-2 py-1.5">
        <p className="text-on-surface-muted">Block {index + 1} could not be read</p>
        <pre className="mt-1 font-mono whitespace-pre-wrap break-words text-[10px] text-on-surface-secondary">
          {formatStructuredPlain(block, 500)}
        </pre>
      </li>
    );
  }

  const title = presentText(rec.title);
  const date = presentText(rec.date);
  const start = presentText(rec.start);
  const end = presentText(rec.end);
  const timeZone = presentText(rec.time_zone);
  const estimate = presentText(rec.estimated_minutes);
  const taskId = presentText(rec.task_id);

  return (
    <li className="rounded-md border border-border/40 px-2 py-1.5">
      <p className="font-medium text-on-surface">{title ?? "Title missing"}</p>
      <p className="mt-0.5 text-on-surface-secondary">
        <span className="text-on-surface-muted">Date </span>
        {date ?? "—"}
        <span aria-hidden="true"> · </span>
        <span className="text-on-surface-muted">Time </span>
        {start ?? "—"}–{end ?? "—"}
        <span aria-hidden="true"> · </span>
        <span className="text-on-surface-muted">Time zone </span>
        {timeZone ?? "—"}
        <span aria-hidden="true"> · </span>
        <span className="text-on-surface-muted">Estimate </span>
        {estimate !== null ? `${estimate} min` : "—"}
      </p>
      <p className="mt-0.5 font-mono text-[10px] text-on-surface-muted break-all">
        <span className="text-on-surface-muted">Task </span>
        {taskId ?? "Task ID missing"}
      </p>
    </li>
  );
}

/**
 * Exact approved schedule blocks — display only, no normalization.
 * Falls back to generic bounded JSON when the payload shape is unusable.
 */
function ApplyAutoScheduleArgs({ args }: { args: Record<string, unknown> }) {
  const blocks = args.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return <GenericArgsPlain args={args} />;
  }

  const date = presentText(args.date);

  return (
    <div className="px-3 py-2 text-xs text-on-surface-secondary max-h-40 overflow-auto">
      <p className="mb-2">
        <span className="text-on-surface-muted">Date </span>
        <span className="font-medium text-on-surface">{date ?? "—"}</span>
      </p>
      <ul className="space-y-1.5" aria-label="Approved schedule blocks">
        {blocks.map((block, index) => (
          <ScheduleBlockItem key={index} block={block} index={index} />
        ))}
      </ul>
    </div>
  );
}

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
  const headerLabel = toolDisplayLabel(proposal.tool);
  const isApplySchedule = proposal.tool === APPLY_AUTO_SCHEDULE_DAY_TOOL;

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
        <span className="text-xs font-medium text-on-surface-secondary">Approve {headerLabel}</span>
        {!pending && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-on-surface-muted">
            {proposal.decision}
          </span>
        )}
      </div>
      {isApplySchedule ? (
        <ApplyAutoScheduleArgs args={proposal.arguments} />
      ) : (
        <GenericArgsPlain args={proposal.arguments} />
      )}
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
