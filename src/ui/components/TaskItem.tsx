import { Calendar, Pencil, Trash2 } from "lucide-react";
import type { TaskDto } from "../api/client";
import { calendarDayKey, formatRelativeDate } from "../lib/dates";

interface TaskItemProps {
  task: TaskDto;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  isSelected: boolean;
  todayKey: string;
}

export function TaskItem({ task, onToggle, onSelect, isSelected, todayKey: today }: TaskItemProps) {
  const dueDay = task.due_date ? calendarDayKey(task.due_date) : null;
  const isOverdue = dueDay !== null && task.status === "pending" && dueDay < today;
  const isCompleted = task.status === "completed";

  const checkboxClassName = [
    "relative w-7 h-7 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors duration-200",
    isCompleted ? "bg-success border-success" : "border-accent-action hover:bg-accent-action/10",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`group relative flex items-center gap-2 px-3 py-2 border-b border-border/30 transition-all duration-150 ${
        isSelected
          ? "bg-accent-action/5 ring-1 ring-accent-action/50"
          : "hover:bg-surface-secondary"
      }`}
    >
      {/* Priority-colored circle (unified checkbox + completion) */}
      <div className="relative flex-shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(task.id);
          }}
          aria-label={
            isCompleted ? `Mark task incomplete: ${task.title}` : `Complete task: ${task.title}`
          }
          className={`${checkboxClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface`}
        >
          {isCompleted && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-surface">
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
      </div>

      {/* Dedicated open-details target */}
      <button
        type="button"
        data-task-focus-control
        data-task-id={task.id}
        aria-label={`Task: ${task.title}`}
        onClick={() => onSelect(task.id)}
        className="min-w-0 flex-1 self-stretch rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm truncate ${
                isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
              }`}
            >
              {task.title}
            </span>
          </div>
          {task.due_date && (
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className={`text-xs flex items-center gap-1 flex-shrink-0 ${
                  isOverdue ? "text-error font-medium" : "text-on-surface-muted"
                }`}
              >
                <Calendar size={11} />
                {formatRelativeDate(task.due_date)}
              </span>
            </div>
          )}
        </div>
      </button>

      {/* Sibling edit/delete actions */}
      <div className="relative flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity duration-150 flex-shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(task.id);
          }}
          aria-label={`Edit task: ${task.title}`}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-surface-tertiary text-on-surface-muted hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(task.id);
          }}
          aria-label={`Delete task: ${task.title}`}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-surface-tertiary text-on-surface-muted hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
