import { useState, useEffect, useRef } from "react";
import { X, Trash2, Inbox } from "lucide-react";
import type { TaskDto } from "../api/client";
import { calendarDayKey, formatRelativeDate } from "../lib/dates";

interface TaskDetailPanelProps {
  task: TaskDto;
  onUpdate: (taskId: string, title: string, dueDate: string | null) => Promise<boolean>;
  onDelete: (taskId: string) => Promise<boolean>;
  onToggleComplete: (taskId: string) => Promise<boolean>;
  onClose: () => void;
  todayKey: string;
}

export function TaskDetailPanel({
  task,
  onUpdate,
  onDelete,
  onToggleComplete,
  onClose,
  todayKey,
}: TaskDetailPanelProps) {
  const [title, setTitle] = useState(task.title);
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Sync state when task changes
  useEffect(() => {
    setTitle(task.title);
    setDueDate(task.due_date ?? "");
    setError(null);
  }, [task.id, task.title, task.due_date]);

  // Focus trap: focus title on open
  useEffect(() => {
    titleRef.current?.focus();
  }, [task.id]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSave = async () => {
    if (pending) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title must not be empty.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const dueDateValue = dueDate.trim() || null;
      const success = await onUpdate(task.id, trimmedTitle, dueDateValue);
      if (!success) {
        setError("Could not save changes.");
      }
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const success = await onDelete(task.id);
      if (success) {
        onClose();
      } else {
        setError("Could not delete the task.");
      }
    } finally {
      setPending(false);
    }
  };

  const handleToggleComplete = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onToggleComplete(task.id);
    } finally {
      setPending(false);
    }
  };

  const dueDay = task.due_date ? calendarDayKey(task.due_date) : null;
  const isOverdue = dueDay !== null && task.status === "pending" && dueDay < todayKey;
  const isCompleted = task.status === "completed";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Task: ${task.title}`}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md mx-4 bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-3 md:px-6">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-on-surface-muted">
            <Inbox size={12} className="shrink-0" />
            <span className="truncate">Inbox</span>
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              onClick={onClose}
              aria-label="Close task details"
              className="min-h-7 min-w-7 rounded-md p-2 text-on-surface-muted transition-colors hover:bg-surface-tertiary hover:text-on-surface"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 pb-5 pt-4 max-h-[calc(100dvh-8rem)] overflow-y-auto">
          {/* Completion toggle + Title */}
          <div className="flex items-start gap-3 mb-4">
            <button
              type="button"
              onClick={() => void handleToggleComplete()}
              disabled={pending}
              aria-label={
                isCompleted ? `Mark task incomplete: ${task.title}` : `Complete task: ${task.title}`
              }
              className={`mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:opacity-60 ${
                isCompleted
                  ? "bg-success border-success"
                  : "border-accent-action hover:bg-accent-action/10"
              }`}
            >
              {isCompleted && (
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
            <div className="flex-1 min-w-0">
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={pending}
                aria-label="Task title"
                className={`w-full text-base font-medium bg-transparent border-none outline-none text-on-surface focus:ring-0 ${
                  isCompleted ? "line-through text-on-surface-muted" : ""
                }`}
              />
              {task.due_date && (
                <p
                  className={`text-xs flex items-center gap-1 mt-1 ${
                    isOverdue ? "text-error font-medium" : "text-on-surface-muted"
                  }`}
                >
                  Due: {formatRelativeDate(task.due_date)}
                </p>
              )}
            </div>
          </div>

          {/* Due date field */}
          <div className="mb-4">
            <label
              htmlFor="task-due-date"
              className="block text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-1"
            >
              Due Date
            </label>
            <div className="flex items-center gap-2">
              <input
                id="task-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={pending}
                className="flex-1 px-3 py-2 border border-border rounded-lg bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-focus"
              />
              {task.due_date && (
                <button
                  type="button"
                  onClick={() => setDueDate("")}
                  disabled={pending}
                  aria-label="Clear due date"
                  className="px-2 py-2 text-xs text-on-surface-muted hover:text-on-surface border border-border rounded-lg transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Error display */}
          {error && (
            <p role="alert" className="mb-3 text-xs text-error">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={pending}
              className="flex-1 px-4 py-2.5 rounded-lg bg-accent-action text-on-accent-action font-medium text-sm hover:bg-accent-action-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={pending}
              aria-label="Delete task"
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-error/30 text-error font-medium text-sm hover:bg-error/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
