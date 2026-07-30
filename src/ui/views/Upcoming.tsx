/**
 * Upcoming view: overdue section + future date-grouped tasks.
 * Preserves the legacy Clock header, month label, and date group headers.
 */
import { useMemo } from "react";
import { Clock } from "lucide-react";
import { TaskInput } from "../components/TaskInput";
import { TaskList } from "../components/TaskList";
import { OverdueSection } from "../components/OverdueSection";
import { EmptyState } from "../components/Skeleton";
import { useViewTasks } from "../hooks/useViewTasks";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useWorkspace } from "../context/WorkspaceContext";
import { useToday } from "../hooks/useToday";
import { calendarDayKey } from "../lib/dates";
import type { TaskDto, TagDto } from "../api/client";

interface UpcomingProps {
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    orderedIds: string[],
  ) => void;
  autoFocusTrigger?: number;
  onToggleTask: (id: string) => Promise<boolean>;
}

function formatDateGroupHeader(dateStr: string, todayStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  const label = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    weekday: "long",
  });
  if (dateStr === todayStr) return `${label} · Today`;
  return label;
}

function formatMonthHeader(): string {
  return new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Partition Upcoming rows with the list response as-of day (browser today only as fallback). */
export function partitionUpcomingByAsOfDate(
  tasks: TaskDto[],
  asOfDate: string,
): { overdueTasks: TaskDto[]; upcomingTasks: TaskDto[] } {
  const overdueTasks = tasks
    .filter((t) => {
      const dueDay = t.due_date ? calendarDayKey(t.due_date) : null;
      return t.status === "pending" && dueDay !== null && dueDay < asOfDate;
    })
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));

  const upcomingTasks = tasks
    .filter((t) => {
      const dueDay = t.due_date ? calendarDayKey(t.due_date) : null;
      return t.status === "pending" && dueDay !== null && dueDay > asOfDate;
    })
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));

  return { overdueTasks, upcomingTasks };
}

export function Upcoming({
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  autoFocusTrigger,
  onToggleTask,
}: UpcomingProps) {
  const today = useToday();
  const { catalog } = useWorkspace();
  const { parseQuickEntry, createFromQuickEntry, patchTask } = useTaskMutations();
  const { tasks, loading, error, reload, asOfDate } = useViewTasks({
    view: "upcoming",
    limit: 100,
  });
  // Prefer the server list as_of_date so overdue/future buckets match query membership.
  const effectiveToday = asOfDate ?? today;

  const tagMap = useMemo(() => {
    const map = new Map<string, TagDto>();
    for (const tag of catalog?.tags ?? []) map.set(tag.id, tag);
    return map;
  }, [catalog]);

  const projectMap = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const p of catalog?.projects ?? []) {
      map.set(p.id, { name: p.name, color: p.color });
    }
    return map;
  }, [catalog]);

  const { overdueTasks, upcomingTasks } = useMemo(
    () => partitionUpcomingByAsOfDate(tasks, effectiveToday),
    [tasks, effectiveToday],
  );

  const dateGroups = useMemo(() => {
    const groups: { date: string; tasks: TaskDto[] }[] = [];
    let currentDate = "";
    let currentGroup: TaskDto[] = [];
    for (const task of upcomingTasks) {
      const day = calendarDayKey(task.due_date!)!;
      if (day !== currentDate) {
        if (currentGroup.length > 0) groups.push({ date: currentDate, tasks: currentGroup });
        currentDate = day;
        currentGroup = [task];
      } else {
        currentGroup.push(task);
      }
    }
    if (currentGroup.length > 0) groups.push({ date: currentDate, tasks: currentGroup });
    return groups;
  }, [upcomingTasks]);

  const totalCount = overdueTasks.length + upcomingTasks.length;

  const handleParseAndCreate = async (input: string): Promise<boolean> => {
    const parsed = await parseQuickEntry(input);
    const result = await createFromQuickEntry(parsed);
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

  const projectName = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task?.project_id) return null;
    return projectMap.get(task.project_id)?.name ?? null;
  };
  const projectColor = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task?.project_id) return null;
    return projectMap.get(task.project_id)?.color ?? null;
  };

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Clock size={24} className="text-accent-foreground" />
          <h1 className="text-xl md:text-2xl font-bold text-on-surface">Upcoming</h1>
        </div>
        <p className="text-sm text-on-surface-muted mb-4 md:mb-6" role="status">
          Loading…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4">
        <p className="text-sm font-medium text-error">Could not load upcoming tasks: {error}</p>
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
      <div className="flex items-center gap-3 mb-1">
        <Clock size={24} className="text-accent-foreground" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Upcoming</h1>
      </div>
      <p className="text-sm text-on-surface-muted mb-4 md:mb-6">
        {totalCount} {totalCount === 1 ? "task" : "tasks"}
      </p>

      <TaskInput
        onParseAndCreate={handleParseAndCreate}
        placeholder='Add an upcoming task... (e.g., "plan trip next monday p2")'
        autoFocusTrigger={autoFocusTrigger}
      />

      <OverdueSection
        tasks={overdueTasks}
        onToggleTask={onToggleTask}
        onSelectTask={onSelectTask}
        onReschedule={handleReschedule}
        selectedTaskId={selectedTaskId}
      />

      <h2 className="text-lg font-semibold text-on-surface mb-4">{formatMonthHeader()}</h2>

      {dateGroups.length === 0 ? (
        <EmptyState
          icon={<Clock size={40} strokeWidth={1.25} />}
          title="No upcoming tasks"
          description="Tasks with future due dates will appear here."
        />
      ) : (
        <div className="space-y-6">
          {dateGroups.map((group) => (
            <div key={group.date}>
              <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2 px-1">
                {formatDateGroupHeader(group.date, effectiveToday)}
              </h3>
              <TaskList
                tasks={group.tasks}
                onToggle={onToggleTask}
                onSelect={onSelectTask}
                selectedTaskId={selectedTaskId}
                selectedTaskIds={selectedTaskIds}
                onMultiSelect={onMultiSelect}
                emptyMessage="No tasks"
                todayKey={effectiveToday}
                tagMap={tagMap}
                projectName={projectName}
                projectColor={projectColor}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
