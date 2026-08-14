/**
 * First-party Calendar: Day/Week/Month with civil-date range reads.
 * Optional project filter reuses this implementation for /projects/:id/calendar.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { ApiError, listCalendarTasks, type ProjectDto, type TaskDto } from "../api/client";
import { useWorkspace } from "../context/WorkspaceContext";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { isVisualFixture } from "../lib/visualFixture";
import { SegmentedControl } from "../components/SegmentedControl";
import { ViewSkeleton } from "../components/Skeleton";
import { CalendarDayView } from "./calendar/CalendarDayView";
import { CalendarMonthView } from "./calendar/CalendarMonthView";
import { CalendarWeekView } from "./calendar/CalendarWeekView";
import {
  addCivilDays,
  calendarRequestRange,
  groupTasksByDueDate,
  toCivilDateKey,
  type CalendarMode,
  weekStartToDayNumber,
} from "./calendar/calendarRange";
import { useCalendarNavigation } from "./calendar/useCalendarNavigation";

interface CalendarProps {
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => Promise<boolean>;
  /** Optional project filter — project calendar route reuses this view. */
  projectId?: string | null;
  project?: ProjectDto | null;
}

export function Calendar({ onSelectTask, onToggleTask, projectId = null }: CalendarProps) {
  const { catalog, settings } = useWorkspace();
  const { patchTask } = useTaskMutations();
  const preservePhase3Calendar = isVisualFixture(window.location.search, "phase-3");
  const weekStartDay = preservePhase3Calendar
    ? 1
    : weekStartToDayNumber(settings?.date_time.week_start ?? "sunday");
  const authoritativeMode = preservePhase3Calendar
    ? null
    : ((settings?.date_time.calendar_default ?? null) as CalendarMode | null);
  const nav = useCalendarNavigation({
    initialMode: "week",
    weekStartDay,
    authoritativeMode,
  });
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const liveRegionId = useId();
  const [liveMessage, setLiveMessage] = useState("");
  const requestSeq = useRef(0);

  const range = useMemo(
    () => calendarRequestRange(nav.selectedDate, nav.mode, nav.weekStartDay),
    [nav.selectedDate, nav.mode, nav.weekStartDay],
  );

  const projects = catalog?.projects ?? [];
  const tags = catalog?.tags ?? [];

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const response = await listCalendarTasks({
        from: range.from,
        to: range.to,
        ...(projectId ? { project_id: projectId } : {}),
      });
      if (seq !== requestSeq.current) return;
      setTasks(
        [...response.tasks].sort(
          (left, right) =>
            (left.priority ?? 5) - (right.priority ?? 5) ||
            left.sort_order - right.sort_order ||
            left.id.localeCompare(right.id),
        ),
      );
    } catch (caught) {
      if (seq !== requestSeq.current) return;
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError("Could not load calendar tasks.");
      }
      setTasks([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [range.from, range.to, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const taskCount = useMemo(() => {
    if (nav.mode === "day") {
      const key = toCivilDateKey(nav.selectedDate);
      return (groupTasksByDueDate(tasks).get(key) ?? []).length;
    }
    return tasks.filter((t) => t.due_date).length;
  }, [tasks, nav.mode, nav.selectedDate]);

  const handleDayClick = (date: Date) => {
    nav.setDate(date);
    nav.setMode("day");
  };

  const rescheduleTask = useCallback(
    async (taskId: string, dueDate: string | null): Promise<boolean> => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return false;
      if ((task.due_date ?? null) === dueDate) return true;

      setMutationPending(true);
      setMutationError(null);
      try {
        const result = await patchTask(
          taskId,
          { due_date: dueDate },
          dueDate ? "Reschedule task" : "Clear due date",
        );
        if (!result) {
          setMutationError("The task could not be rescheduled.");
          setLiveMessage("Reschedule failed.");
          return false;
        }
        setTasks((current) =>
          current.map((t) => (t.id === taskId ? { ...t, due_date: dueDate } : t)),
        );
        setLiveMessage(
          dueDate ? `Moved ${task.title} to ${dueDate}.` : `Cleared due date for ${task.title}.`,
        );
        // Reload authoritative range (task may leave/enter the window).
        void load();
        return true;
      } catch {
        setMutationError("The task could not be rescheduled.");
        setLiveMessage("Reschedule failed.");
        return false;
      } finally {
        setMutationPending(false);
      }
    },
    [tasks, patchTask, load],
  );

  const handleDropTaskOnDay = useCallback(
    async (taskId: string, dueDate: string) => rescheduleTask(taskId, dueDate),
    [rescheduleTask],
  );

  const shiftFocusedTask = useCallback(
    async (deltaDays: number) => {
      if (!focusedTaskId || mutationPending) return;
      const task = tasks.find((t) => t.id === focusedTaskId);
      if (!task?.due_date) return;
      const next = addCivilDays(task.due_date, deltaDays);
      const ok = await rescheduleTask(task.id, next);
      if (!ok) {
        requestAnimationFrame(() =>
          document.getElementById(`calendar-task-focus-${task.id}`)?.focus(),
        );
      }
    },
    [focusedTaskId, mutationPending, tasks, rescheduleTask],
  );

  return (
    <div
      className="flex h-full -m-3 flex-col md:-m-6"
      aria-busy={loading || mutationPending || undefined}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <CalendarRange size={22} className="shrink-0 text-accent-foreground" />
          <h1 className="truncate text-base font-semibold text-on-surface md:text-lg">
            {nav.periodLabel}
          </h1>
          {nav.mode === "day" && taskCount > 0 && (
            <span className="shrink-0 rounded-full bg-surface-secondary px-2 py-0.5 text-xs text-on-surface-muted">
              {taskCount} task{taskCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            label="Calendar view"
            options={[
              { value: "day" as CalendarMode, label: "Day" },
              { value: "week" as CalendarMode, label: "Week" },
              { value: "month" as CalendarMode, label: "Month" },
            ]}
            value={nav.mode}
            onChange={nav.setMode}
          />
          <div className="ml-1 flex items-center gap-1 md:ml-2">
            <button
              type="button"
              onClick={nav.goPrev}
              aria-label={`Previous ${nav.mode}`}
              className="rounded-lg p-2 text-on-surface-muted transition-colors hover:bg-surface-secondary hover:text-on-surface md:p-1.5"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={nav.goToday}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors md:py-1 ${
                nav.isCurrentPeriod
                  ? "bg-accent-action/10 text-accent-foreground"
                  : "text-on-surface-muted hover:bg-surface-secondary hover:text-on-surface"
              }`}
            >
              Today
            </button>
            <button
              type="button"
              onClick={nav.goNext}
              aria-label={`Next ${nav.mode}`}
              className="rounded-lg p-2 text-on-surface-muted transition-colors hover:bg-surface-secondary hover:text-on-surface md:p-1.5"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>

      <div id={liveRegionId} role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>

      {(error || mutationError) && (
        <div
          role="alert"
          className="border-b border-error/30 bg-error/5 px-4 py-2 text-sm text-error"
        >
          {mutationError ?? error}
          {error && (
            <button type="button" onClick={() => void load()} className="ml-2 underline">
              Retry
            </button>
          )}
        </div>
      )}

      {focusedTaskId && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-secondary px-4 py-2 text-xs text-on-surface-muted">
          <span>Selected task keyboard moves:</span>
          <button
            type="button"
            id={`calendar-task-focus-${focusedTaskId}`}
            disabled={mutationPending}
            onClick={() => void shiftFocusedTask(-1)}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            Move earlier one day
          </button>
          <button
            type="button"
            disabled={mutationPending}
            onClick={() => void shiftFocusedTask(1)}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            Move later one day
          </button>
          <button
            type="button"
            disabled={mutationPending}
            onClick={() => {
              setFocusedTaskId(null);
              setLiveMessage("Task deselected.");
            }}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Clear selection
          </button>
        </div>
      )}

      <div key={nav.mode} className="flex min-h-0 flex-1 flex-col animate-fade-in">
        {loading && tasks.length === 0 ? (
          <ViewSkeleton />
        ) : (
          <>
            {nav.mode === "week" && (
              <CalendarWeekView
                selectedDate={nav.selectedDate}
                weekStartDay={nav.weekStartDay}
                tasks={tasks}
                projects={projects}
                onSelectTask={(id) => {
                  setFocusedTaskId(id);
                  onSelectTask(id);
                }}
                onToggleTask={onToggleTask}
                onDayClick={handleDayClick}
                onDropTaskOnDay={handleDropTaskOnDay}
              />
            )}
            {nav.mode === "month" && (
              <CalendarMonthView
                selectedDate={nav.selectedDate}
                weekStartDay={nav.weekStartDay}
                tasks={tasks}
                projects={projects}
                onSelectTask={(id) => {
                  setFocusedTaskId(id);
                  onSelectTask(id);
                }}
                onDayClick={handleDayClick}
                onDropTaskOnDay={handleDropTaskOnDay}
              />
            )}
            {nav.mode === "day" && (
              <CalendarDayView
                selectedDate={nav.selectedDate}
                tasks={tasks}
                projects={projects}
                tags={tags}
                onSelectTask={(id) => {
                  setFocusedTaskId(id);
                  onSelectTask(id);
                }}
                onToggleTask={onToggleTask}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
