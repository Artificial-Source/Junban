/**
 * Compact task card rendered inline in AI chat messages after tool calls.
 * Shows task title, status, priority flag, and due date. Clickable to open task detail.
 */

import { CheckCircle2, Circle, Flag, Calendar } from "lucide-react";

interface ChatTaskCardProps {
  task: {
    id: string;
    title: string;
    status?: string;
    priority?: number | null;
    dueDate?: string | null;
  };
  onClick?: (taskId: string) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "text-error",
  2: "text-warning",
  3: "text-info",
  4: "text-on-surface-muted",
};

export function ChatTaskCard({ task, onClick }: ChatTaskCardProps) {
  const isCompleted = task.status === "completed";

  return (
    <button
      onClick={() => onClick?.(task.id)}
      className="w-full text-left px-2.5 py-2 rounded-md border border-border bg-surface hover:bg-surface-secondary transition-colors flex items-center gap-2 group"
    >
      {isCompleted ? (
        <CheckCircle2 size={14} className="text-success shrink-0" />
      ) : (
        <Circle size={14} className="text-on-surface-muted shrink-0" />
      )}
      <span
        className={`flex-1 text-xs truncate ${
          isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
        }`}
      >
        {task.title}
      </span>
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
