import { useMemo, useCallback } from "react";
import { Clock } from "lucide-react";
import { parseTask } from "../../parser/task-parser.js";
import { toDateKey } from "../../utils/format-date.js";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import { OverdueSection } from "../components/OverdueSection.js";
import { EmptyState } from "../components/EmptyState.js";
import type { Task, Project } from "../../core/types.js";

interface UpcomingProps {
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
  autoFocusTrigger?: number;
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
  const now = new Date();
  return now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function Upcoming({
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
  autoFocusTrigger,
}: UpcomingProps) {
  const today = toDateKey(new Date());

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const overdueTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < today)
        .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)),
    [tasks, today],
  );

  const upcomingTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] >= today)
        .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)),
    [tasks, today],
  );

  // Group by date
  const dateGroups = useMemo(() => {
    const groups: { date: string; tasks: Task[] }[] = [];
    let currentDate = "";
    let currentGroup: Task[] = [];

    for (const task of upcomingTasks) {
      const day = task.dueDate!.split("T")[0];
      if (day !== currentDate) {
        if (currentGroup.length > 0) {
          groups.push({ date: currentDate, tasks: currentGroup });
        }
        currentDate = day;
        currentGroup = [task];
      } else {
        currentGroup.push(task);
      }
    }
    if (currentGroup.length > 0) {
      groups.push({ date: currentDate, tasks: currentGroup });
    }

    return groups;
  }, [upcomingTasks]);

  const totalCount = overdueTasks.length + upcomingTasks.length;

  const handleReschedule = useCallback(async () => {
    const todayISO = new Date().toISOString();
    for (const task of overdueTasks) {
      await onUpdateTask(task.id, { dueDate: todayISO });
    }
  }, [overdueTasks, onUpdateTask]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Clock size={24} className="text-accent" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Upcoming</h1>
      </div>
      <p className="text-sm text-on-surface-muted mb-4 md:mb-6">
        {totalCount} {totalCount === 1 ? "task" : "tasks"}
      </p>

      <TaskInput
        onSubmit={onCreateTask}
        placeholder='Add an upcoming task... (e.g., "plan trip next monday p2")'
        autoFocusTrigger={autoFocusTrigger}
      />

      <OverdueSection
        tasks={overdueTasks}
        projects={projectMap}
        onSelectTask={onSelectTask}
        onToggleTask={onToggleTask}
        onReschedule={handleReschedule}
        selectedTaskId={selectedTaskId}
      />

      {/* Month header */}
      <h2 className="text-lg font-semibold text-on-surface mb-4">{formatMonthHeader()}</h2>

      {/* Date-grouped sections */}
      {dateGroups.length === 0 ? (
        <EmptyState
          icon={<Clock size={40} strokeWidth={1.25} />}
          title="No upcoming tasks"
          description="Tasks with due dates will appear here."
        />
      ) : (
        <div className="space-y-6">
          {dateGroups.map((group) => (
            <div key={group.date}>
              <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2 px-1">
                {formatDateGroupHeader(group.date, today)}
              </h3>
              <TaskList
                tasks={group.tasks}
                onToggle={onToggleTask}
                onSelect={onSelectTask}
                selectedTaskId={selectedTaskId}
                selectedTaskIds={selectedTaskIds}
                onMultiSelect={onMultiSelect}
                onReorder={onReorder}
                onAddSubtask={onAddSubtask}
                onUpdateDueDate={onUpdateDueDate}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
