import { useState, useMemo, useCallback } from "react";
import { parseTask } from "../../parser/task-parser.js";
import { toDateKey } from "../../utils/format-date.js";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import { OverdueSection } from "../components/OverdueSection.js";
import { CompletionRing } from "../components/CompletionRing.js";
import { DailyPlanningModal } from "../components/DailyPlanningModal.js";
import { DailyReviewModal } from "../components/DailyReviewModal.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { TaskJar } from "../components/TaskJar.js";
import type { Task, Project } from "../../core/types.js";

interface TodayProps {
  tasks: Task[];
  projects: Project[];
  onCreateTask: (input: ReturnType<typeof parseTask>) => void;
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  onUpdateTask: (id: string, updates: Record<string, unknown>) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  onReorder?: (orderedIds: string[]) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
  onContextMenu?: (taskId: string, position: { x: number; y: number }) => void;
  autoFocusTrigger?: number;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function WorkloadCapacityBar({ planned, capacity }: { planned: number; capacity: number }) {
  const pct = Math.min((planned / capacity) * 100, 100);
  const over = planned > capacity;

  return (
    <div className="mb-4 px-1">
      <div className="flex items-center justify-between text-xs text-on-surface-muted mb-1">
        <span>
          {formatDuration(planned)} / {formatDuration(capacity)} planned
        </span>
        {over && (
          <span className="text-error font-medium">
            +{formatDuration(planned - capacity)} over
          </span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-surface-tertiary overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${over ? "bg-error" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function formatTodayHeader(): string {
  const now = new Date();
  const month = now.toLocaleDateString(undefined, { month: "short" });
  const day = now.getDate();
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  return `${month} ${day} · Today · ${weekday}`;
}

export function Today({
  tasks,
  projects,
  onCreateTask,
  onToggleTask,
  onSelectTask,
  onUpdateTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onReorder,
  onAddSubtask,
  onUpdateDueDate,
  onContextMenu,
  autoFocusTrigger,
}: TodayProps) {
  const { settings } = useGeneralSettings();
  const [planningOpen, setPlanningOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const today = toDateKey(new Date());

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const overdueTasks = useMemo(
    () =>
      tasks.filter((t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < today),
    [tasks, today],
  );

  const todayTasks = useMemo(
    () => tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today)),
    [tasks, today],
  );

  const todayCompletedCount = useMemo(
    () => tasks.filter((t) => t.status === "completed" && t.completedAt?.startsWith(today)).length,
    [tasks, today],
  );

  const totalCount = overdueTasks.length + todayTasks.length;
  const ringTotal = todayCompletedCount + todayTasks.length;

  // Workload capacity
  const capacityMinutes = parseInt(settings.daily_capacity_minutes, 10) || 480;
  const plannedMinutes = useMemo(
    () =>
      [...overdueTasks, ...todayTasks].reduce(
        (sum, t) => sum + (t.estimatedMinutes ?? 0),
        0,
      ),
    [overdueTasks, todayTasks],
  );

  const handleReschedule = useCallback(async () => {
    const todayISO = new Date().toISOString();
    for (const task of overdueTasks) {
      await onUpdateTask(task.id, { dueDate: todayISO });
    }
  }, [overdueTasks, onUpdateTask]);

  return (
    <div>
      {/* Header row: "Today" title + task count + CompletionRing */}
      <div className="flex items-center justify-between mb-4 md:mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl md:text-3xl font-bold text-on-surface">Today</h1>
          <button
            onClick={() => setPlanningOpen(true)}
            className="px-3 py-1 text-xs font-medium rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            Plan My Day
          </button>
          <button
            onClick={() => setReviewOpen(true)}
            className="px-3 py-1 text-xs font-medium rounded-full bg-surface-tertiary text-on-surface-muted hover:bg-surface-tertiary/80 transition-colors"
          >
            End of Day
          </button>
        </div>
        <div className="flex items-center gap-3">
          <TaskJar tasks={tasks} onSelectTask={onSelectTask} />
          <span className="text-sm text-on-surface-muted">
            {totalCount} {totalCount === 1 ? "task" : "tasks"}
          </span>
          {ringTotal > 0 && <CompletionRing completed={todayCompletedCount} total={ringTotal} />}
        </div>
      </div>

      {/* Workload capacity bar */}
      {plannedMinutes > 0 && (
        <WorkloadCapacityBar planned={plannedMinutes} capacity={capacityMinutes} />
      )}

      <TaskInput
        onSubmit={onCreateTask}
        placeholder="Add a task for today..."
        autoFocusTrigger={autoFocusTrigger}
        defaultDueDate={new Date(today + "T00:00:00")}
      />

      {/* Overdue section (unchanged behavior) */}
      <OverdueSection
        tasks={overdueTasks}
        projects={projectMap}
        onSelectTask={onSelectTask}
        onToggleTask={onToggleTask}
        onReschedule={handleReschedule}
        selectedTaskId={selectedTaskId}
      />

      {/* Today section with bold date header + accent underline */}
      <div>
        <h2 className="text-base font-bold text-on-surface mb-1 px-1">{formatTodayHeader()}</h2>
        <div className="h-0.5 bg-accent mb-3 rounded-full" />
        <TaskList
          tasks={todayTasks}
          onToggle={onToggleTask}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
          emptyMessage={
            overdueTasks.length === 0
              ? "No tasks for today. Add one above to get started!"
              : "Nothing else due today."
          }
          selectedTaskIds={selectedTaskIds}
          onMultiSelect={onMultiSelect}
          onReorder={onReorder}
          onAddSubtask={onAddSubtask}
          onUpdateDueDate={onUpdateDueDate}
          onContextMenu={onContextMenu}
        />
      </div>

      <DailyPlanningModal
        open={planningOpen}
        onComplete={() => setPlanningOpen(false)}
        tasks={tasks}
        projects={projects}
        onUpdateTask={onUpdateTask}
      />
      <DailyReviewModal
        open={reviewOpen}
        onComplete={() => setReviewOpen(false)}
        tasks={tasks}
        onUpdateTask={onUpdateTask}
      />
    </div>
  );
}
