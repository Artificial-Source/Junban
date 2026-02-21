import { useMemo, useCallback } from "react";
import { CalendarDays } from "lucide-react";
import { parseTask } from "../../parser/task-parser.js";
import { toDateKey } from "../../utils/format-date.js";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import { OverdueSection } from "../components/OverdueSection.js";
import { CompletionRing } from "../components/CompletionRing.js";
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
  autoFocusTrigger?: number;
}

function formatTodayHeader(): string {
  const now = new Date();
  return now.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    weekday: "long",
  });
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
  autoFocusTrigger,
}: TodayProps) {
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

  const handleReschedule = useCallback(async () => {
    const todayISO = new Date().toISOString();
    for (const task of overdueTasks) {
      await onUpdateTask(task.id, { dueDate: todayISO });
    }
  }, [overdueTasks, onUpdateTask]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <CalendarDays size={24} className="text-accent" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Today</h1>
        <span className="text-sm text-on-surface-muted">
          {new Date().toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </span>
      </div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <p className="text-sm text-on-surface-muted">
          {totalCount} {totalCount === 1 ? "task" : "tasks"}
        </p>
        {ringTotal > 0 && <CompletionRing completed={todayCompletedCount} total={ringTotal} />}
      </div>

      <TaskInput
        onSubmit={onCreateTask}
        placeholder='Add a task for today... (e.g., "buy milk p1")'
        autoFocusTrigger={autoFocusTrigger}
        defaultDueDate={new Date(today + "T00:00:00")}
      />

      <OverdueSection
        tasks={overdueTasks}
        projects={projectMap}
        onSelectTask={onSelectTask}
        onToggleTask={onToggleTask}
        onReschedule={handleReschedule}
        selectedTaskId={selectedTaskId}
      />

      {/* Today Section */}
      <div>
        <h2 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2 px-1">
          {formatTodayHeader()} · Today
        </h2>
        <TaskList
          tasks={todayTasks}
          onToggle={onToggleTask}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
          emptyMessage="Nothing due today!"
          selectedTaskIds={selectedTaskIds}
          onMultiSelect={onMultiSelect}
          onReorder={onReorder}
          onAddSubtask={onAddSubtask}
          onUpdateDueDate={onUpdateDueDate}
        />
      </div>
    </div>
  );
}
