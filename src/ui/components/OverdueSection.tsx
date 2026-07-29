import { AlertTriangle, Calendar, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { TaskDto } from "../api/client";
import { formatDate } from "../lib/dates";

interface OverdueSectionProps {
  tasks: TaskDto[];
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  onReschedule: () => void;
  selectedTaskId: string | null;
}

export function OverdueSection({
  tasks,
  onToggleTask,
  onSelectTask,
  onReschedule,
  selectedTaskId,
}: OverdueSectionProps) {
  const [expanded, setExpanded] = useState(true);

  if (tasks.length === 0) return null;

  return (
    <section className="mb-6" aria-labelledby="overdue-heading">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls="overdue-task-list"
          className="flex min-h-6 items-center gap-1 rounded text-sm font-semibold text-error transition-colors hover:text-error/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {expanded ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
          <AlertTriangle size={14} aria-hidden="true" />
          <span id="overdue-heading">Overdue</span>
        </button>
        <span className="text-xs font-medium text-error">{tasks.length}</span>
        <button
          type="button"
          onClick={() => void onReschedule()}
          className="ml-auto min-h-6 rounded px-1 text-xs font-medium text-accent-foreground transition-colors hover:text-accent-foreground-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Reschedule
        </button>
      </div>
      {expanded && (
        <div id="overdue-task-list">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`relative flex items-start gap-3 rounded-lg border-b border-border/30 px-3 py-3 transition-colors last:border-b-0 ${
                selectedTaskId === task.id
                  ? "bg-accent-action/5 ring-1 ring-accent-action/50"
                  : "hover:bg-surface-secondary"
              }`}
            >
              <button
                type="button"
                onClick={() => onToggleTask(task.id)}
                aria-label={`Complete task: ${task.title}`}
                className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 border-on-surface-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 ${
                  task.status === "completed"
                    ? "bg-success border-success"
                    : "border-on-surface-muted/30"
                }`}
              >
                {task.status === "completed" && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-surface"
                  >
                    <path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={() => onSelectTask(task.id)}
                aria-label={`Open task: ${task.title}`}
                className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span
                  className={`block truncate text-sm ${
                    task.status === "completed"
                      ? "line-through text-on-surface-muted"
                      : "text-on-surface"
                  }`}
                >
                  {task.title}
                </span>
                <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-error">
                  <Calendar size={11} aria-hidden="true" />
                  {formatDate(task.due_date!)}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
