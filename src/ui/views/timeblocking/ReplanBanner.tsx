/**
 * Automatic replan for unlocked prior-week blocks.
 * Bulk actions only: move today / tomorrow / delete. Locked blocks are skipped server-side.
 */
import { AlertCircle, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ReplanTimeBlocksActionDto, TimeBlockDto } from "../../api/client";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { formatRelativeDate } from "../../lib/dates";
import { normalizeCivilTime } from "./timeblockingRange";

interface ReplanBannerProps {
  staleBlocks: TimeBlockDto[];
  pending?: boolean;
  error?: string | null;
  onReplan: (action: ReplanTimeBlocksActionDto) => Promise<boolean>;
}

const ACTIONS: Array<{
  action: ReplanTimeBlocksActionDto;
  label: string;
  description: string;
  danger?: boolean;
}> = [
  {
    action: "move_to_today",
    label: "Move all to today",
    description: "Move unlocked prior-week blocks onto today.",
  },
  {
    action: "move_to_tomorrow",
    label: "Move all to tomorrow",
    description: "Move unlocked prior-week blocks onto tomorrow.",
  },
  {
    action: "delete",
    label: "Delete unlocked past blocks",
    description: "Permanently delete unlocked prior-week blocks.",
    danger: true,
  },
];

export function ReplanBanner({
  staleBlocks,
  pending = false,
  error = null,
  onReplan,
}: ReplanBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ReplanTimeBlocksActionDto | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open && !confirmAction);
  const titleId = useId();
  const descId = useId();

  if (staleBlocks.length === 0 || dismissed) return null;

  const lockedNote = "Locked blocks are never moved or deleted by automatic replan.";

  const run = async (action: ReplanTimeBlocksActionDto) => {
    const ok = await onReplan(action);
    if (ok) {
      setConfirmAction(null);
      setOpen(false);
    }
  };

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2"
        data-testid="replan-banner"
      >
        <AlertCircle size={16} className="flex-shrink-0 text-warning" aria-hidden />
        <span className="flex-1 text-sm text-on-surface">
          You have <strong>{staleBlocks.length}</strong> unlocked{" "}
          {staleBlocks.length === 1 ? "block" : "blocks"} from the prior week.
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-accent-action px-3 py-1 text-xs font-medium text-on-accent-action hover:bg-accent-action-hover"
          data-testid="replan-open-btn"
        >
          Replan
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded p-1 text-on-surface-muted hover:bg-surface-secondary"
          aria-label="Dismiss replan banner"
        >
          <X size={14} />
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget && !pending) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-border bg-surface shadow-xl"
            data-testid="replan-modal"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 id={titleId} className="text-sm font-semibold text-on-surface">
                Replan unlocked past blocks
              </h3>
              <button
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
                className="rounded p-1 text-on-surface-muted hover:bg-surface-secondary"
                aria-label="Close replan dialog"
              >
                <X size={16} />
              </button>
            </div>
            <div id={descId} className="space-y-2 overflow-y-auto p-4">
              <p className="text-xs text-on-surface-muted">{lockedNote}</p>
              <ul className="space-y-2">
                {staleBlocks.slice(0, 20).map((block) => (
                  <li
                    key={block.occurrence_key}
                    className="rounded-md border border-border bg-surface-secondary px-3 py-2"
                    data-testid={`replan-item-${block.id}`}
                  >
                    <div className="truncate text-sm font-medium text-on-surface">
                      {block.title}
                    </div>
                    <div className="mt-0.5 text-xs text-on-surface-muted">
                      {formatRelativeDate(block.date)} · {normalizeCivilTime(block.start)} –{" "}
                      {normalizeCivilTime(block.end)}
                      {block.locked ? " · locked" : ""}
                    </div>
                  </li>
                ))}
              </ul>
              {staleBlocks.length > 20 && (
                <p className="text-xs text-on-surface-muted">
                  Showing 20 of {staleBlocks.length} eligible blocks.
                </p>
              )}
              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
                >
                  {error}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-secondary"
              >
                Close
              </button>
              {ACTIONS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  disabled={pending}
                  data-testid={`replan-action-${item.action}`}
                  onClick={() => setConfirmAction(item.action)}
                  className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${
                    item.danger
                      ? "bg-error text-white hover:opacity-90"
                      : "bg-accent-action text-on-accent-action hover:bg-accent-action-hover"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="replan-confirm-title"
            aria-describedby="replan-confirm-desc"
            className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
            data-testid="replan-confirm-dialog"
          >
            <h4 id="replan-confirm-title" className="text-sm font-semibold text-on-surface">
              Confirm replan
            </h4>
            <p id="replan-confirm-desc" className="mt-2 text-sm text-on-surface-secondary">
              {ACTIONS.find((item) => item.action === confirmAction)?.description} {lockedNote}
            </p>
            {error && (
              <div
                role="alert"
                className="mt-3 rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
              >
                {error}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmAction(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                data-testid="replan-confirm-btn"
                onClick={() => void run(confirmAction)}
                className="rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action disabled:opacity-50"
              >
                {pending ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
