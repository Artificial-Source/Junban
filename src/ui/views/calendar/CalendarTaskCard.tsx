import { useId, useState } from "react";
import { Circle, CheckCircle2 } from "lucide-react";
import type { ProjectDto, TagDto, TaskDto } from "../../api/client";
import { TaskMutationFeedback } from "../../components/TaskMutationFeedback";

interface CalendarTaskCardProps {
  task: TaskDto;
  project: ProjectDto | null;
  tags?: TagDto[];
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => Promise<boolean>;
  onDragStart?: (taskId: string) => void;
  size?: "week" | "day";
  timeLabel?: string | null;
  draggable?: boolean;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "border-l-red-500",
  2: "border-l-amber-500",
  3: "border-l-accent-action",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

const PRIORITY_TAG_COLORS: Record<number, string> = {
  1: "bg-red-500/10 text-red-500",
  2: "bg-amber-500/10 text-amber-500",
  3: "bg-blue-500/10 text-accent-foreground",
  4: "bg-surface-tertiary text-on-surface-muted",
};

export function CalendarTaskCard({
  task,
  project,
  tags = [],
  onSelectTask,
  onToggleTask,
  onDragStart,
  size = "week",
  timeLabel = null,
  draggable = false,
}: CalendarTaskCardProps) {
  const isCompleted = task.status === "completed";
  const priority = task.priority ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = `${useId()}-calendar-task-feedback`;

  const priorityBorder =
    !isCompleted && priority
      ? (PRIORITY_COLORS[priority] ?? "border-l-transparent")
      : "border-l-transparent";

  const completionLabel = isCompleted
    ? `Mark task incomplete: ${task.title}`
    : `Complete task: ${task.title}`;
  const openLabel = `Open task: ${task.title}`;
  const isDay = size === "day";

  const handleToggle = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const ok = await onToggleTask(task.id);
      if (!ok) setError("The task could not be updated.");
    } catch {
      setError("The task could not be updated.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      draggable={draggable && !isCompleted}
      onDragStart={(e) => {
        if (!draggable || isCompleted) return;
        e.dataTransfer.setData("text/junban-task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.(task.id);
      }}
      className={`group relative ${
        isDay ? "rounded-lg border-l-3" : "rounded-md border-l-2"
      } ${priorityBorder} transition-[box-shadow,opacity] ${isCompleted ? "opacity-50" : "hover:shadow-sm"}`}
    >
      <div className="flex items-start">
        <button
          type="button"
          onClick={() => void handleToggle()}
          disabled={pending}
          aria-busy={pending || undefined}
          aria-describedby={error ? errorId : undefined}
          aria-label={completionLabel}
          className={`flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded text-on-surface-muted transition-colors hover:text-accent-foreground-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait disabled:opacity-60 ${
            isDay ? "mt-0.5 min-h-8 min-w-8" : "mt-px"
          }`}
        >
          {isCompleted ? (
            <CheckCircle2
              size={isDay ? 18 : 14}
              className="text-accent-foreground md:h-3 md:w-3"
              aria-hidden="true"
            />
          ) : (
            <Circle size={isDay ? 18 : 14} className="md:h-3 md:w-3" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onSelectTask(task.id)}
          aria-label={openLabel}
          className={`min-w-0 flex-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
            isCompleted
              ? "bg-surface-secondary/50"
              : "bg-surface-secondary hover:bg-surface-tertiary"
          } ${
            isDay
              ? "rounded-r-lg px-3 py-2.5 text-sm"
              : "min-h-[44px] rounded-r-md px-2 py-2.5 text-xs leading-tight md:min-h-0 md:px-1.5 md:py-1.5 md:text-[11px]"
          }`}
        >
          <span
            className={`block line-clamp-2 break-words [overflow-wrap:anywhere] ${
              isCompleted ? "text-on-surface-muted line-through" : "text-on-surface"
            }`}
          >
            {task.title}
          </span>

          {isDay ? (
            <span className="mt-1 flex flex-wrap items-center gap-2">
              {timeLabel && <span className="text-xs text-on-surface-muted">{timeLabel}</span>}
              {project && (
                <span className="flex items-center gap-1 text-xs text-on-surface-muted">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: project.color }}
                    aria-hidden="true"
                  />
                  {project.name}
                </span>
              )}
              {!isCompleted && priority && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    PRIORITY_TAG_COLORS[priority] ?? ""
                  }`}
                >
                  {PRIORITY_LABELS[priority]}
                </span>
              )}
              {tags.length > 0 && (
                <span className="text-xs text-on-surface-muted">
                  {tags.map((t) => `#${t.name}`).join(" ")}
                </span>
              )}
            </span>
          ) : (
            project && (
              <span className="ml-5 mt-0.5 flex items-center gap-1 md:ml-4">
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color }}
                  aria-hidden="true"
                />
                <span className="truncate text-[10px] text-on-surface-muted">{project.name}</span>
              </span>
            )
          )}
        </button>
      </div>

      <TaskMutationFeedback
        state={error ? "error" : "idle"}
        message={error}
        className="mx-2 mt-1 text-xs text-error"
      />
    </div>
  );
}
