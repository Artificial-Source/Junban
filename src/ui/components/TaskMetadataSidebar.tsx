import { useState } from "react";
import type { Task, UpdateTaskInput } from "../../core/types.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { StatusSection } from "./task-metadata/StatusSection.js";
import { DateFields } from "./task-metadata/DateFields.js";
import { PriorityDreadSection } from "./task-metadata/PriorityDreadSection.js";
import { TagsSection } from "./task-metadata/TagsSection.js";
import { ReminderRecurrenceSection } from "./task-metadata/ReminderRecurrenceSection.js";
import { DurationSection } from "./task-metadata/DurationSection.js";
import { DeleteAction } from "./task-metadata/DeleteAction.js";

const PRIORITY_LABELS: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

interface TaskMetadataSidebarProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  onDelete: (id: string) => void;
  availableTags?: string[];
}

export function TaskMetadataSidebar({
  task,
  onUpdate,
  onDelete,
  availableTags = [],
}: TaskMetadataSidebarProps) {
  const { settings } = useGeneralSettings();

  // Reset local state when task changes
  const [trackedTaskId, setTrackedTaskId] = useState(task.id);
  if (task.id !== trackedTaskId) {
    setTrackedTaskId(task.id);
  }

  const dueLabel = task.dueDate
    ? new Date(task.dueDate).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "No date";

  return (
    <aside className="scrollbar-panel w-full border-t border-border bg-surface-secondary/35 md:w-80 md:border-t-0 md:border-l md:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-surface-secondary)_84%,transparent),transparent_22%)] overflow-auto p-4 md:p-5 flex-shrink-0">
      <div className="space-y-3">
        <div className="rounded-2xl border border-border/70 bg-surface/80 px-4 py-3 shadow-[0_10px_30px_-20px_rgba(0,0,0,0.45)] backdrop-blur-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-on-surface-muted">
                Task details
              </p>
              <p className="mt-1 text-sm text-on-surface-secondary">
                Metadata and scheduling controls
              </p>
            </div>
            <div className="h-10 w-1 rounded-full bg-gradient-to-b from-accent via-accent/60 to-transparent" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full border border-border/60 bg-surface-secondary px-2.5 py-1 text-[11px] font-medium text-on-surface-secondary">
              {task.status}
            </span>
            {task.priority && (
              <span className="rounded-full border border-accent/20 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">
                {PRIORITY_LABELS[task.priority]}
              </span>
            )}
            <span className="rounded-full border border-border/60 bg-surface-secondary px-2.5 py-1 text-[11px] font-medium text-on-surface-secondary">
              {dueLabel}
            </span>
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
          <StatusSection task={task} onUpdate={onUpdate} />
        </div>

        <div className="rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
          <DateFields
            task={task}
            onUpdate={onUpdate}
            showDeadline={settings.feature_deadlines !== "false"}
          />
        </div>

        <div className="rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
          <PriorityDreadSection task={task} onUpdate={onUpdate} />
        </div>

        <div className="rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
          <TagsSection task={task} onUpdate={onUpdate} availableTags={availableTags} />
        </div>

        <div className="rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
          <ReminderRecurrenceSection task={task} onUpdate={onUpdate} />
        </div>

        {settings.feature_duration !== "false" && (
          <div className="rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
            <DurationSection task={task} onUpdate={onUpdate} />
          </div>
        )}

        <div className="rounded-2xl border border-error/20 bg-error/5 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
          <DeleteAction taskId={task.id} onDelete={onDelete} />
        </div>
      </div>
    </aside>
  );
}
