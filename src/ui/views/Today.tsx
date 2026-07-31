/**
 * Today view: overdue section + today tasks with workload summary.
 * Preserves the legacy header with completion ring.
 * Plan My Day / End of Day / Weekly Review openers are large-desktop only.
 * Create defaults to today when the Rust parser gives no date.
 */
import { useMemo } from "react";
import { TaskInput } from "../components/TaskInput";
import { OverdueSection } from "../components/OverdueSection";
import { TodayHeader } from "./today/TodayHeader";
import { TodayTaskList } from "./today/TodayTaskList";
import { calendarDayKey } from "../lib/dates";
import { useToday } from "../hooks/useToday";
import { useViewTasks } from "../hooks/useViewTasks";
import { useTaskMutations } from "../hooks/useTaskMutations";

interface TodayProps {
  onToggleTask: (id: string) => Promise<boolean>;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    orderedIds: string[],
  ) => void;
  autoFocusTrigger?: number;
  onPlanMyDay?: () => void;
  onEndOfDay?: () => void;
  onWeeklyReview?: () => void;
  /** Reproduce the Phase 2 task-detail authority backdrop only in its visual fixture. */
  phase2DetailVisualFixture?: boolean;
}

export function Today({
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  autoFocusTrigger,
  onPlanMyDay,
  onEndOfDay,
  onWeeklyReview,
  phase2DetailVisualFixture = false,
}: TodayProps) {
  const today = useToday();
  const { parseQuickEntry, createFromQuickEntry, patchTask } = useTaskMutations();
  const { tasks, loading, error, reload, asOfDate } = useViewTasks({ view: "today", limit: 100 });

  // Use server as_of_date if available, otherwise browser local date
  const effectiveToday = asOfDate ?? today;

  const showingPhase2DetailFixture = phase2DetailVisualFixture;
  const overdueTasks = useMemo(
    () =>
      showingPhase2DetailFixture
        ? tasks
        : tasks.filter((t) => {
            const dueDay = t.due_date ? calendarDayKey(t.due_date) : null;
            return t.status === "pending" && dueDay !== null && dueDay < effectiveToday;
          }),
    [showingPhase2DetailFixture, tasks, effectiveToday],
  );

  const todayTasks = useMemo(
    () =>
      showingPhase2DetailFixture
        ? []
        : tasks.filter(
            (t) =>
              t.status === "pending" &&
              t.due_date !== null &&
              t.due_date !== undefined &&
              calendarDayKey(t.due_date) === effectiveToday,
          ),
    [showingPhase2DetailFixture, tasks, effectiveToday],
  );

  const todayCompletedCount = useMemo(
    () =>
      tasks.filter((t) => {
        if (t.status !== "completed" || !t.completed_at) return false;
        return calendarDayKey(t.completed_at) === effectiveToday;
      }).length,
    [tasks, effectiveToday],
  );

  const totalCount = showingPhase2DetailFixture
    ? tasks.length
    : overdueTasks.length + todayTasks.length;
  const ringTotal = todayCompletedCount + todayTasks.length;

  // Workload: sum of estimated minutes for today's tasks
  const workloadMinutes = useMemo(
    () =>
      showingPhase2DetailFixture
        ? 0
        : todayTasks.reduce((sum, t) => sum + (t.estimated_minutes ?? 0), 0),
    [showingPhase2DetailFixture, todayTasks],
  );

  const handleParseAndCreate = async (input: string): Promise<boolean> => {
    const parsed = await parseQuickEntry(input);
    const result = await createFromQuickEntry(parsed, {
      due_date: parsed.due_date ?? effectiveToday,
    });
    if (!result) {
      throw new Error("The task could not be created.");
    }
    return true;
  };

  const handleReschedule = async () => {
    for (const task of overdueTasks) {
      await patchTask(task.id, { due_date: effectiveToday });
    }
  };

  if (loading) {
    return (
      <div>
        <TodayHeader
          totalCount={0}
          todayCompletedCount={0}
          ringTotal={0}
          onPlanMyDay={onPlanMyDay}
          onEndOfDay={onEndOfDay}
          onWeeklyReview={onWeeklyReview}
        />
        <p className="text-sm text-on-surface-muted" role="status">
          Loading tasks…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4">
        <p className="text-sm font-medium text-error">Could not load tasks: {error}</p>
        <button
          onClick={reload}
          className="mt-2 rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <TodayHeader
        totalCount={totalCount}
        todayCompletedCount={todayCompletedCount}
        ringTotal={ringTotal}
        onPlanMyDay={onPlanMyDay}
        onEndOfDay={onEndOfDay}
        onWeeklyReview={onWeeklyReview}
      />

      {workloadMinutes > 0 && (
        <p className="mb-2 text-xs text-on-surface-muted" aria-live="polite">
          Workload: {Math.floor(workloadMinutes / 60)}h {workloadMinutes % 60}m estimated
        </p>
      )}

      <TaskInput
        onParseAndCreate={handleParseAndCreate}
        placeholder="Add a task for today..."
        autoFocusTrigger={autoFocusTrigger}
      />

      <OverdueSection
        tasks={overdueTasks}
        onToggleTask={onToggleTask}
        onSelectTask={onSelectTask}
        onReschedule={handleReschedule}
        selectedTaskId={selectedTaskId}
      />

      <TodayTaskList
        todayTasks={todayTasks}
        overdueTasks={overdueTasks}
        onToggleTask={onToggleTask}
        onSelectTask={onSelectTask}
        selectedTaskId={selectedTaskId}
        selectedTaskIds={selectedTaskIds}
        onMultiSelect={onMultiSelect}
        todayKey={effectiveToday}
      />
    </div>
  );
}
