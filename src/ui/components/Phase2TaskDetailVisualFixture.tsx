import { lazy, Suspense, type ReactNode } from "react";
import { X } from "lucide-react";
import type { TaskDto } from "../api/client";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })),
);

/**
 * Frozen Phase 2 evidence only. This intentionally presents the one immutable
 * detail scene without reproducing the editable production task panel.
 */
export function Phase2TaskDetailVisualFixture({
  task,
  onClose,
}: {
  task: TaskDto;
  onClose: () => void;
}) {
  const field = (label: string, control: ReactNode) => (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
        {label}
      </label>
      {control}
    </div>
  );
  const inputClass =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Task: ${task.title}`}
      onClick={onClose}
    >
      <div
        data-testid="task-detail-surface"
        className="mx-4 w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface shadow-2xl animate-scale-fade-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center border-b border-border px-6 py-3">
          <span className="flex flex-1 items-center gap-1.5 text-xs text-on-surface-muted">
            <span className="h-2 w-2 rounded-full bg-success" /> Documentation
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close task details"
            className="min-h-7 min-w-7 rounded-md p-2 text-on-surface-muted transition-colors hover:bg-surface-tertiary hover:text-on-surface"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto px-5 pb-5 pt-4">
          <div className="mb-4 flex items-start gap-3">
            <span className="mt-1 h-7 w-7 flex-shrink-0 rounded-full border-2 border-accent-action" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-on-surface">{task.title}</p>
              <p className="mt-1 text-xs text-on-surface-muted">Due: Today</p>
            </div>
          </div>

          <div className="mb-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
              Description
            </p>
            <div className="min-h-[60px] rounded-lg border border-border/50 p-3 text-sm text-on-surface">
              <Suspense fallback={<span className="text-on-surface-muted">Loading…</span>}>
                <MarkdownPreview content={task.description} />
              </Suspense>
            </div>
          </div>

          <div className="mb-4">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
              Due Date
            </label>
            <div className="flex items-center gap-2">
              <input
                className={`flex-1 ${inputClass}`}
                type="date"
                defaultValue={task.due_date ?? ""}
                readOnly
              />
              <button
                className="rounded-lg border border-border px-2 py-2 text-xs text-on-surface-muted"
                type="button"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {field(
              "Priority",
              <select className={inputClass} defaultValue="1">
                <option value="1">P1 — Urgent</option>
              </select>,
            )}
            {field("Deadline", <input className={inputClass} type="datetime-local" readOnly />)}
            {field(
              "Someday",
              <label className="flex items-center gap-2">
                <input className="h-4 w-4 rounded border-border" type="checkbox" readOnly />
                <span className="text-sm text-on-surface">Park in Someday / Maybe</span>
              </label>,
            )}
            {field(
              "Estimated (min)",
              <input
                className={inputClass}
                type="number"
                defaultValue={task.estimated_minutes ?? ""}
                readOnly
              />,
            )}
            {field("Actual (min)", <input className={inputClass} type="number" readOnly />)}
            {field(
              "Dread (1-5)",
              <select className={inputClass} defaultValue="">
                <option value="">None</option>
              </select>,
            )}
            {field(
              "Project",
              <select className={inputClass} defaultValue="Documentation">
                <option>Documentation</option>
              </select>,
            )}
            {field(
              "Section",
              <select className={inputClass} defaultValue="">
                <option value="">No section</option>
              </select>,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
