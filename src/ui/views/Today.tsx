import { lazy, Suspense, useState, useMemo, useCallback } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import type { ParsedTask } from "../../parser/task-parser.js";
import { useToday } from "../hooks/useToday.js";
import { TaskInput } from "../components/TaskInput.js";
import { OverdueSection } from "../components/OverdueSection.js";
import type { WeeklyReviewData } from "../components/WeeklyReviewModal.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import type { Task, Project } from "../../core/types.js";
import { TodayHeader } from "./today/TodayHeader.js";
import { TodayTaskList } from "./today/TodayTaskList.js";
import { WorkloadCapacityBar } from "./today/WorkloadCapacityBar.js";
import { useWeeklyReviewData } from "./today/useWeeklyReviewData.js";

const EatTheFrog = lazy(() =>
  import("../components/EatTheFrog.js").then((module) => ({ default: module.EatTheFrog })),
);
const DailyPlanningModal = lazy(() =>
  import("../components/DailyPlanningModal.js").then((module) => ({
    default: module.DailyPlanningModal,
  })),
);
const DailyReviewModal = lazy(() =>
  import("../components/DailyReviewModal.js").then((module) => ({
    default: module.DailyReviewModal,
  })),
);
const WeeklyReviewModal = lazy(() =>
  import("../components/WeeklyReviewModal.js").then((module) => ({
    default: module.WeeklyReviewModal,
  })),
);

interface TodayProps {
  tasks: Task[];
  projects: Project[];
  onCreateTask: (input: ParsedTask) => void;
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
  const [weeklyReviewOpen, setWeeklyReviewOpen] = useState(false);
  const [weeklyReviewData, setWeeklyReviewData] = useState<WeeklyReviewData | null>(null);
  const { today, todayDate } = useToday();

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
    () => [...overdueTasks, ...todayTasks].reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0),
    [overdueTasks, todayTasks],
  );

  const computeWeeklyReviewData = useWeeklyReviewData(tasks, projects);
  const lazyFallback = null;

  const handleOpenWeeklyReview = useCallback(() => {
    setWeeklyReviewData(computeWeeklyReviewData());
    setWeeklyReviewOpen(true);
  }, [computeWeeklyReviewData]);

  const handleReschedule = useCallback(async () => {
    const todayISO = new Date().toISOString();
    for (const task of overdueTasks) {
      await onUpdateTask(task.id, { dueDate: todayISO });
    }
  }, [overdueTasks, onUpdateTask]);

  return (
    <div>
      <TodayHeader
        totalCount={totalCount}
        todayCompletedCount={todayCompletedCount}
        ringTotal={ringTotal}
        tasks={tasks}
        onSelectTask={onSelectTask}
        onPlanMyDay={() => setPlanningOpen(true)}
        onEndOfDay={() => setReviewOpen(true)}
        onWeeklyReview={handleOpenWeeklyReview}
      />

      {plannedMinutes > 0 && (
        <WorkloadCapacityBar planned={plannedMinutes} capacity={capacityMinutes} />
      )}

      <TaskInput
        onSubmit={onCreateTask}
        placeholder="Add a task for today..."
        autoFocusTrigger={autoFocusTrigger}
        defaultDueDate={todayDate}
      />

      {/* Eat the Frog — highest dread task */}
      {settings.eat_the_frog_enabled !== "false" &&
        !(settings.eat_the_frog_morning_only === "true" && new Date().getHours() >= 12) && (
          <ErrorBoundary fallback={lazyFallback}>
            <Suspense fallback={lazyFallback}>
              <EatTheFrog
                tasks={[...overdueTasks, ...todayTasks]}
                onToggleTask={onToggleTask}
                onSelectTask={onSelectTask}
              />
            </Suspense>
          </ErrorBoundary>
        )}

      <OverdueSection
        tasks={overdueTasks}
        projects={projectMap}
        onSelectTask={onSelectTask}
        onToggleTask={onToggleTask}
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
        onReorder={onReorder}
        onAddSubtask={onAddSubtask}
        onUpdateDueDate={onUpdateDueDate}
        onContextMenu={onContextMenu}
      />

      {planningOpen && (
        <ErrorBoundary fallback={lazyFallback}>
          <Suspense fallback={lazyFallback}>
            <DailyPlanningModal
              open={planningOpen}
              onComplete={() => setPlanningOpen(false)}
              tasks={tasks}
              projects={projects}
              onUpdateTask={onUpdateTask}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {reviewOpen && (
        <ErrorBoundary fallback={lazyFallback}>
          <Suspense fallback={lazyFallback}>
            <DailyReviewModal
              open={reviewOpen}
              onComplete={() => setReviewOpen(false)}
              tasks={tasks}
              onUpdateTask={onUpdateTask}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {weeklyReviewOpen && (
        <ErrorBoundary fallback={lazyFallback}>
          <Suspense fallback={lazyFallback}>
            <WeeklyReviewModal
              open={weeklyReviewOpen}
              onClose={() => setWeeklyReviewOpen(false)}
              data={weeklyReviewData}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}
