/**
 * Full-shell Focus Mode overlay.
 * Navigates all pending tasks (not just the filtered view that opened it).
 * Exit clears `?focus=1` via the parent; mutations block accidental dismiss.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Check, SkipForward, ChevronLeft } from "lucide-react";
import { listTasks, type TaskDto } from "../api/client";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useWorkspace } from "../context/WorkspaceContext";
import { formatDate, calendarDayKey, todayKey } from "../lib/dates";

const PRIORITY_DECORATION_CLASSES: Record<number, string> = {
  1: "bg-priority-1",
  2: "bg-priority-2",
  3: "bg-priority-3",
  4: "bg-priority-4",
};

const EDITABLE_SELECTOR = [
  "input",
  "select",
  "textarea",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="spinbutton"]',
].join(",");

const SPACE_NATIVE_OWNERSHIP_SELECTOR = [
  "button",
  "a[href]",
  "audio[controls]",
  "video[controls]",
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  EDITABLE_SELECTOR,
].join(",");

interface FocusModeProps {
  open: boolean;
  /** Optional task id to start on when present in the pending sequence. */
  startTaskId?: string | null;
  onClose: () => void;
  onPendingChange?: (pending: boolean) => void;
}

async function loadAllPending(): Promise<TaskDto[]> {
  const tasks: TaskDto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const response = await listTasks({
      status: "pending",
      sort: "sort_order_asc",
      limit: 100,
      cursor,
    });
    tasks.push(...response.tasks);
    if (!response.next_cursor) break;
    cursor = response.next_cursor;
  }
  return tasks;
}

export function FocusMode({ open, startTaskId, onClose, onPendingChange }: FocusModeProps) {
  const { catalog, registerTaskEventHandler, registerTaskResyncHandler } = useWorkspace();
  const { completeTask, patchTask } = useTaskMutations();
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const completeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const startAppliedRef = useRef(false);

  useFocusTrap(dialogRef, open);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const pendingTasks = await loadAllPending();
      setTasks(pendingTasks);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Could not load pending tasks.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      startAppliedRef.current = false;
      return;
    }
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open || startAppliedRef.current || tasks.length === 0) return;
    if (startTaskId) {
      const idx = tasks.findIndex((t) => t.id === startTaskId);
      if (idx >= 0) setCurrentIndex(idx);
    }
    startAppliedRef.current = true;
  }, [open, startTaskId, tasks]);

  useEffect(() => {
    if (!open) return;
    return registerTaskEventHandler(() => {
      void reload();
    });
  }, [open, registerTaskEventHandler, reload]);

  useEffect(() => {
    if (!open) return;
    return registerTaskResyncHandler(() => {
      void reload();
    });
  }, [open, registerTaskResyncHandler, reload]);

  const currentTask = tasks[currentIndex] ?? null;
  const total = tasks.length;
  const progress = total > 0 ? currentIndex + 1 : 0;

  const tagNames = useMemo(() => {
    if (!currentTask || !catalog) return [] as string[];
    return currentTask.tag_ids
      .map((id) => catalog.tags.find((t) => t.id === id)?.name)
      .filter((name): name is string => Boolean(name));
  }, [catalog, currentTask]);

  const goNext = useCallback(() => {
    if (pendingRef.current) return;
    setCurrentIndex((i) => Math.min(i + 1, Math.max(total - 1, 0)));
  }, [total]);

  const goPrev = useCallback(() => {
    if (pendingRef.current) return;
    setCurrentIndex((i) => Math.max(i - 1, 0));
  }, []);

  const requestClose = useCallback(() => {
    if (pendingRef.current) return;
    onClose();
  }, [onClose]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, failure: string) => {
      if (!currentTask || pendingRef.current) return false;
      pendingRef.current = true;
      dialogRef.current?.focus({ preventScroll: true });
      setPending(true);
      onPendingChange?.(true);
      setError(null);
      try {
        const result = await action();
        if (result === null) {
          setError(failure);
          requestAnimationFrame(() => completeButtonRef.current?.focus({ preventScroll: true }));
          return false;
        }
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : failure);
        requestAnimationFrame(() => completeButtonRef.current?.focus({ preventScroll: true }));
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
        onPendingChange?.(false);
      }
    },
    [currentTask, onPendingChange],
  );

  const completeAndAdvance = useCallback(async () => {
    if (!currentTask) return;
    const ok = await runAction(
      () => completeTask(currentTask.id),
      "The task could not be completed.",
    );
    if (!ok) return;
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== currentTask.id);
      setCurrentIndex((idx) => Math.min(idx, Math.max(next.length - 1, 0)));
      return next;
    });
  }, [completeTask, currentTask, runAction]);

  const snoozeOneDay = useCallback(async () => {
    if (!currentTask) return;
    const base = currentTask.due_date ?? todayKey();
    const d = new Date(`${base}T12:00:00`);
    d.setDate(d.getDate() + 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const ok = await runAction(
      () => patchTask(currentTask.id, { due_date: next }, "Snooze task"),
      "The task could not be snoozed.",
    );
    if (ok) goNext();
  }, [currentTask, goNext, patchTask, runAction]);

  const scheduleToday = useCallback(async () => {
    if (!currentTask) return;
    const ok = await runAction(
      () => patchTask(currentTask.id, { due_date: todayKey() }, "Schedule today"),
      "The task could not be scheduled.",
    );
    if (ok) goNext();
  }, [currentTask, goNext, patchTask, runAction]);

  useEffect(() => {
    if (!open || !pending) return;
    const blockUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", blockUnload);
    return () => window.removeEventListener("beforeunload", blockUnload);
  }, [open, pending]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.repeat ||
        e.isComposing ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.shiftKey
      ) {
        return;
      }
      if (e.target instanceof Element && e.target.closest(EDITABLE_SELECTOR)) return;

      switch (e.key) {
        case " ":
          if (e.target instanceof Element && e.target.closest(SPACE_NATIVE_OWNERSHIP_SELECTOR)) {
            return;
          }
          e.preventDefault();
          if (!pendingRef.current) void completeAndAdvance();
          break;
        case "n":
          e.preventDefault();
          if (!pendingRef.current) goNext();
          break;
        case "p":
          e.preventDefault();
          if (!pendingRef.current) goPrev();
          break;
        case "s":
          e.preventDefault();
          if (!pendingRef.current) void snoozeOneDay();
          break;
        case "t":
          e.preventDefault();
          if (!pendingRef.current) void scheduleToday();
          break;
        case "ArrowRight":
        case "ArrowDown":
          if (e.target instanceof Element && e.target.closest(SPACE_NATIVE_OWNERSHIP_SELECTOR)) {
            return;
          }
          e.preventDefault();
          if (!pendingRef.current) goNext();
          break;
        case "ArrowLeft":
        case "ArrowUp":
          if (e.target instanceof Element && e.target.closest(SPACE_NATIVE_OWNERSHIP_SELECTOR)) {
            return;
          }
          e.preventDefault();
          if (!pendingRef.current) goPrev();
          break;
        case "Escape":
          e.preventDefault();
          requestClose();
          break;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, completeAndAdvance, goNext, goPrev, requestClose, scheduleToday, snoozeOneDay]);

  if (!open) return null;

  if (loading && tasks.length === 0) {
    return (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Focus mode"
        className="fixed inset-0 z-50 flex h-dvh max-h-dvh w-full max-w-[100vw] items-center justify-center overflow-x-hidden overflow-y-auto overscroll-contain bg-surface/95 px-3 py-4 backdrop-blur-sm"
      >
        <p className="text-sm text-on-surface-muted">Loading Focus Mode…</p>
      </div>
    );
  }

  if (loadError && tasks.length === 0) {
    return (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Focus mode"
        className="fixed inset-0 z-50 flex h-dvh max-h-dvh w-full max-w-[100vw] items-center justify-center overflow-x-hidden overflow-y-auto overscroll-contain bg-surface/95 px-3 py-4 backdrop-blur-sm"
      >
        <div className="text-center">
          <p role="alert" className="mb-3 text-sm text-error">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mr-2 rounded-lg bg-accent-action px-4 py-2 text-sm text-on-accent-action"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={requestClose}
            className="rounded-lg bg-surface-tertiary px-4 py-2 text-sm text-on-surface-secondary"
          >
            Exit
          </button>
        </div>
      </div>
    );
  }

  if (total === 0 || !currentTask) {
    return (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Focus mode"
        aria-busy={pending || undefined}
        className="fixed inset-0 z-50 flex h-dvh max-h-dvh w-full max-w-[100vw] items-center justify-center overflow-x-hidden overflow-y-auto overscroll-contain bg-surface/95 px-3 py-4 backdrop-blur-sm"
      >
        <div className="my-auto min-w-0 max-w-full text-center">
          <h2 className="mb-2 break-words text-2xl font-bold text-on-surface">All done!</h2>
          <p className="mb-6 break-words text-on-surface-muted">
            No more pending tasks to focus on.
          </p>
          {pending && (
            <p
              id="focus-mode-empty-pending"
              role="status"
              className="mb-3 text-sm text-on-surface-secondary"
            >
              Saving completion. Focus Mode cannot close yet.
            </p>
          )}
          <button
            data-autofocus
            type="button"
            onClick={requestClose}
            disabled={pending}
            aria-describedby={pending ? "focus-mode-empty-pending" : undefined}
            className="rounded-lg bg-accent-action px-6 py-2 text-on-accent-action transition-colors hover:bg-accent-action-hover disabled:cursor-wait disabled:opacity-60"
          >
            Exit Focus Mode
          </button>
        </div>
      </div>
    );
  }

  const dueDay = currentTask.due_date ? calendarDayKey(currentTask.due_date) : null;
  const overdue = dueDay !== null && dueDay < todayKey();

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Focus mode"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex h-dvh max-h-dvh w-full max-w-[100vw] flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-surface/95 backdrop-blur-sm"
      aria-busy={pending || undefined}
    >
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 px-3 py-2 sm:px-6 sm:py-4">
        <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <span className="text-sm font-medium text-on-surface-muted">Focus Mode</span>
          <span className="rounded-full bg-accent-action/10 px-2 py-0.5 text-xs font-medium text-accent-foreground">
            {progress}/{total}
          </span>
        </div>
        <button
          data-autofocus
          type="button"
          onClick={requestClose}
          aria-label="Exit focus mode"
          disabled={pending}
          aria-describedby={pending ? "focus-mode-pending" : undefined}
          className="shrink-0 rounded-lg p-2 text-on-surface-muted transition-colors hover:bg-surface-tertiary hover:text-on-surface disabled:cursor-wait disabled:opacity-60"
        >
          <X size={20} />
        </button>
      </div>

      <div className="h-1 shrink-0 bg-surface-tertiary">
        <div
          className="h-full bg-accent-action transition-all duration-300"
          style={{ width: `${(progress / total) * 100}%` }}
        />
      </div>

      <div className="flex min-w-0 flex-1 shrink-0 items-center justify-center px-3 py-4 sm:px-6 sm:py-6">
        <div className="w-full min-w-0 max-w-2xl text-center">
          {currentTask.priority != null && (
            <span
              data-testid="focus-priority"
              className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-accent-action bg-surface-tertiary px-2 py-0.5 text-xs font-medium text-on-surface-secondary"
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DECORATION_CLASSES[currentTask.priority] ?? ""}`}
              />
              P{currentTask.priority}
            </span>
          )}

          <h1 className="mb-3 break-words text-2xl font-bold leading-tight text-on-surface [overflow-wrap:anywhere] sm:mb-4 sm:text-4xl">
            {currentTask.title}
          </h1>

          {currentTask.description && (
            <p className="mb-4 break-words whitespace-pre-wrap text-base text-on-surface-secondary [overflow-wrap:anywhere] sm:mb-6 sm:text-lg">
              {currentTask.description}
            </p>
          )}

          {tagNames.length > 0 && (
            <div className="mb-4 flex flex-wrap justify-center gap-2 sm:mb-6">
              {tagNames.map((name) => (
                <span
                  key={name}
                  className="rounded-lg bg-surface-tertiary px-2.5 py-1 font-mono text-sm text-on-surface-secondary"
                >
                  #{name}
                </span>
              ))}
            </div>
          )}

          {currentTask.due_date && (
            <p
              className={`mb-6 text-sm ${overdue ? "font-medium text-error" : "text-on-surface-muted"}`}
            >
              Due: {formatDate(currentTask.due_date)}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-stretch justify-center gap-2 px-3 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6 sm:py-6">
        <button
          type="button"
          onClick={goPrev}
          disabled={pending || currentIndex === 0}
          aria-label="Previous task"
          aria-describedby={pending ? "focus-mode-pending" : undefined}
          className="flex w-full items-center justify-center gap-1 rounded-lg bg-surface-tertiary px-4 py-2.5 text-sm font-medium text-on-surface-secondary transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-30 sm:w-auto"
        >
          <ChevronLeft size={16} /> Previous
        </button>

        <button
          ref={completeButtonRef}
          type="button"
          onClick={() => void completeAndAdvance()}
          disabled={pending}
          aria-busy={pending || undefined}
          aria-describedby={pending ? "focus-mode-pending" : undefined}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-action px-4 py-3 text-base font-medium text-on-accent-action shadow-sm transition-colors hover:bg-accent-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-wait disabled:opacity-60 sm:w-auto sm:px-8"
        >
          <Check size={20} /> Complete
        </button>

        <button
          type="button"
          onClick={goNext}
          disabled={pending || currentIndex >= total - 1}
          aria-label="Skip to next task"
          aria-describedby={pending ? "focus-mode-pending" : undefined}
          className="flex w-full items-center justify-center gap-1 rounded-lg bg-surface-tertiary px-4 py-2.5 text-sm font-medium text-on-surface-secondary transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-30 sm:w-auto"
        >
          Skip <SkipForward size={16} />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 pb-2 sm:px-6">
        <button
          type="button"
          disabled={pending}
          onClick={() => void snoozeOneDay()}
          className="rounded-md px-2 py-1 text-xs text-on-surface-muted hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Snooze 1 day
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void scheduleToday()}
          className="rounded-md px-2 py-1 text-xs text-on-surface-muted hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Schedule today
        </button>
      </div>

      {pending && (
        <p
          id="focus-mode-pending"
          role="status"
          aria-live="polite"
          className="shrink-0 px-3 pb-2 text-center text-sm font-medium text-on-surface-secondary sm:px-6"
        >
          Saving. Focus Mode controls are unavailable until saving finishes.
        </p>
      )}
      {error && (
        <p role="alert" className="shrink-0 px-3 pb-2 text-center text-sm text-error sm:px-6">
          {error}
        </p>
      )}

      <div className="shrink-0 px-3 pb-4 text-center">
        <p className="break-words text-xs text-on-surface-muted">
          <kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-xs">Space</kbd> Complete
          {" · "}
          <kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-xs">N</kbd> Next
          {" · "}
          <kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-xs">P</kbd> Previous
          {" · "}
          <kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-xs">S</kbd> Snooze
          {" · "}
          <kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-xs">T</kbd> Today
          {" · "}
          <kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-xs">Esc</kbd> Exit
        </p>
      </div>
    </div>
  );
}
