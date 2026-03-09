import { useState, useMemo, useCallback } from "react";
import { parseTask } from "../../parser/task-parser.js";
import { toDateKey } from "../../utils/format-date.js";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import { OverdueSection } from "../components/OverdueSection.js";
import { CompletionRing } from "../components/CompletionRing.js";
import { EatTheFrog } from "../components/EatTheFrog.js";
import { DailyPlanningModal } from "../components/DailyPlanningModal.js";
import { DailyReviewModal } from "../components/DailyReviewModal.js";
import { WeeklyReviewModal } from "../components/WeeklyReviewModal.js";
import type { WeeklyReviewData } from "../components/WeeklyReviewModal.js";
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
          <span className="text-error font-medium">+{formatDuration(planned - capacity)} over</span>
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
  const [weeklyReviewOpen, setWeeklyReviewOpen] = useState(false);
  const [weeklyReviewData, setWeeklyReviewData] = useState<WeeklyReviewData | null>(null);
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
    () => [...overdueTasks, ...todayTasks].reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0),
    [overdueTasks, todayTasks],
  );

  const handleOpenWeeklyReview = useCallback(() => {
    // Compute weekly review data client-side from available tasks
    const now = new Date();
    const day = now.getDay();
    const daysBack = day === 0 ? 6 : day - 1;
    const lastMonday = new Date(now);
    lastMonday.setDate(lastMonday.getDate() - (daysBack === 0 ? 7 : daysBack));
    const weekStartStr = toDateKey(lastMonday);
    const weekEndDate = new Date(lastMonday);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekEndStr = toDateKey(weekEndDate);

    function inWeek(dateStr: string | null): boolean {
      if (!dateStr) return false;
      const d = dateStr.split("T")[0];
      return d >= weekStartStr && d <= weekEndStr;
    }

    const completedInWeek = tasks.filter((t) => t.status === "completed" && inWeek(t.completedAt));
    const createdInWeek = tasks.filter((t) => inWeek(t.createdAt));
    const cancelledInWeek = tasks.filter((t) => t.status === "cancelled" && inWeek(t.updatedAt));

    const totalActionable = completedInWeek.length + cancelledInWeek.length;
    const completionRate =
      totalActionable > 0 ? Math.round((completedInWeek.length / totalActionable) * 100) : 0;

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dailyStats = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(lastMonday);
      d.setDate(d.getDate() + i);
      const dStr = toDateKey(d);
      dailyStats.push({
        date: dStr,
        dayName: dayNames[d.getDay()],
        completed: completedInWeek.filter(
          (t) => t.completedAt && t.completedAt.split("T")[0] === dStr,
        ).length,
        created: createdInWeek.filter((t) => t.createdAt && t.createdAt.split("T")[0] === dStr)
          .length,
      });
    }

    const busiestDay = dailyStats.reduce(
      (best, d) => (d.completed > best.completed ? d : best),
      dailyStats[0],
    );

    const bucketCounts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const t of completedInWeek) {
      if (t.completedAt) {
        const hour = new Date(t.completedAt).getHours();
        if (hour >= 5 && hour < 12) bucketCounts.morning++;
        else if (hour >= 12 && hour < 17) bucketCounts.afternoon++;
        else if (hour >= 17 && hour < 21) bucketCounts.evening++;
        else bucketCounts.night++;
      }
    }
    const productiveTime =
      completedInWeek.length > 0
        ? (Object.entries(bucketCounts).sort(([, a], [, b]) => b - a)[0][0] as string)
        : null;

    const todayStr = toDateKey(now);
    const overdueList = tasks
      .filter((t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < todayStr)
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));

    // Streak
    const completedAll = tasks.filter((t) => t.status === "completed");
    let streakDays = 0;
    for (let i = 0; i < 30; i++) {
      const d = new Date(todayStr + "T00:00:00");
      d.setDate(d.getDate() - i);
      const dStr = toDateKey(d);
      const has = completedAll.some((t) => t.completedAt && t.completedAt.split("T")[0] === dStr);
      if (has) streakDays++;
      else if (i > 0) break;
    }

    const topAccomplishments = completedInWeek
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        title: t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title,
        priority: t.priority,
        completedAt: t.completedAt,
        projectId: t.projectId,
      }));

    // Neglected projects
    const neglectedProjects: { id: string; name: string; overdueCount: number; reason: string }[] =
      [];
    for (const project of projects) {
      const pTasks = tasks.filter((t) => t.projectId === project.id);
      const pOverdue = pTasks.filter(
        (t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < todayStr,
      );
      const hadActivity =
        pTasks.some((t) => inWeek(t.completedAt)) || pTasks.some((t) => inWeek(t.createdAt));
      if (pOverdue.length > 0) {
        neglectedProjects.push({
          id: project.id,
          name: project.name,
          overdueCount: pOverdue.length,
          reason: `${pOverdue.length} overdue task${pOverdue.length > 1 ? "s" : ""}`,
        });
      } else if (!hadActivity && pTasks.some((t) => t.status === "pending")) {
        neglectedProjects.push({
          id: project.id,
          name: project.name,
          overdueCount: 0,
          reason: "No activity this week",
        });
      }
    }

    // Suggestions
    const suggestions: string[] = [];
    if (overdueList.length > 0) {
      suggestions.push(
        `Tackle your ${overdueList.length} overdue task${overdueList.length > 1 ? "s" : ""} early in the week.`,
      );
    }
    if (neglectedProjects.length > 0) {
      suggestions.push(
        `Check in on neglected projects: ${neglectedProjects
          .slice(0, 3)
          .map((p) => p.name)
          .join(", ")}.`,
      );
    }
    if (createdInWeek.length > completedInWeek.length && createdInWeek.length > 0) {
      suggestions.push(
        "You created more tasks than you completed — consider being more selective.",
      );
    }
    if (streakDays > 0) {
      suggestions.push(`Keep your ${streakDays}-day streak going!`);
    }

    setWeeklyReviewData({
      weekStartDate: weekStartStr,
      weekEndDate: weekEndStr,
      completionRate,
      taskFlow: {
        created: createdInWeek.length,
        completed: completedInWeek.length,
        cancelled: cancelledInWeek.length,
        net: completedInWeek.length - createdInWeek.length,
      },
      dailyStats,
      busiestDay: busiestDay
        ? { date: busiestDay.date, dayName: busiestDay.dayName, completed: busiestDay.completed }
        : null,
      productiveTime,
      productiveTimeCounts: bucketCounts,
      neglectedProjects: neglectedProjects.slice(0, 10),
      overdue: {
        count: overdueList.length,
        tasks: overdueList.slice(0, 10).map((t) => ({
          id: t.id,
          title: t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title,
          priority: t.priority,
          dueDate: t.dueDate,
        })),
      },
      streak: { currentDays: streakDays, isActive: streakDays > 0 },
      topAccomplishments,
      suggestions: suggestions.slice(0, 4),
    });
    setWeeklyReviewOpen(true);
  }, [tasks, projects]);

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
          <button
            onClick={handleOpenWeeklyReview}
            className="px-3 py-1 text-xs font-medium rounded-full bg-surface-tertiary text-on-surface-muted hover:bg-surface-tertiary/80 transition-colors"
          >
            Weekly Review
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

      {/* Eat the Frog — highest dread task */}
      {settings.eat_the_frog_enabled !== "false" &&
        !(settings.eat_the_frog_morning_only === "true" && new Date().getHours() >= 12) && (
          <EatTheFrog
            tasks={[...overdueTasks, ...todayTasks]}
            onToggleTask={onToggleTask}
            onSelectTask={onSelectTask}
          />
        )}

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
      <WeeklyReviewModal
        open={weeklyReviewOpen}
        onClose={() => setWeeklyReviewOpen(false)}
        data={weeklyReviewData}
      />
    </div>
  );
}
