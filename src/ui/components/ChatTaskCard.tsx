/**
 * Compact task card rendered inline in AI chat messages after tool calls.
 * Shows task title, status, priority flag, due date, tags, and project.
 * Clickable to open task detail. Interactive completion checkbox.
 */

import { useState, useCallback } from "react";
import { CheckCircle2, Circle, Flag, Calendar } from "lucide-react";

interface ChatTaskCardProps {
  task: {
    id: string;
    title: string;
    status?: string;
    priority?: number | null;
    dueDate?: string | null;
    tags?: { name: string; color?: string }[];
    projectName?: string;
    projectColor?: string;
  };
  onClick?: (taskId: string) => void;
  onComplete?: (taskId: string) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "text-error",
  2: "text-warning",
  3: "text-info",
  4: "text-on-surface-muted",
};

export function ChatTaskCard({ task, onClick, onComplete }: ChatTaskCardProps) {
  const [completing, setCompleting] = useState(false);
  const isCompleted = task.status === "completed" || completing;

  const handleComplete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onComplete && task.id && !isCompleted) {
        setCompleting(true);
        onComplete(task.id);
      }
    },
    [onComplete, task.id, isCompleted],
  );

  return (
    <button
      onClick={() => onClick?.(task.id)}
      className="w-full text-left px-3 py-2.5 rounded-xl border border-border bg-surface hover:bg-surface-secondary shadow-sm hover:shadow transition-all flex items-center gap-2.5 group animate-scale-fade-in"
    >
      {onComplete ? (
        <span onClick={handleComplete} className="shrink-0 cursor-pointer">
          {isCompleted ? (
            <CheckCircle2 size={14} className="text-success" />
          ) : (
            <Circle
              size={14}
              className="text-on-surface-muted group-hover:text-accent transition-colors"
            />
          )}
        </span>
      ) : isCompleted ? (
        <CheckCircle2 size={14} className="text-success shrink-0" />
      ) : (
        <Circle size={14} className="text-on-surface-muted shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <span
          className={`text-xs truncate block ${
            isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
          }`}
        >
          {task.title}
        </span>
        {/* Tags and project */}
        {((task.tags && task.tags.length > 0) || task.projectName) && (
          <div className="flex items-center gap-1 mt-0.5">
            {task.projectName && (
              <span className="inline-flex items-center gap-0.5 text-[9px] text-on-surface-muted">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: task.projectColor || "var(--color-accent)" }}
                />
                {task.projectName}
              </span>
            )}
            {task.tags?.map((tag) => (
              <span
                key={tag.name}
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: tag.color || "#6b7280" }}
                title={tag.name}
              />
            ))}
          </div>
        )}
      </div>
      {task.priority && task.priority >= 1 && task.priority <= 4 && (
        <Flag size={10} className={`shrink-0 ${PRIORITY_COLORS[task.priority]}`} />
      )}
      {task.dueDate && (
        <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-on-surface-muted">
          <Calendar size={9} />
          {task.dueDate.slice(0, 10)}
        </span>
      )}
    </button>
  );
}
