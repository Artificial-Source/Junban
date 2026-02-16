import { useState, useMemo } from "react";
import { CalendarDays, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { parseTask } from "../../parser/task-parser.js";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
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
  autoFocusTrigger,
}: TodayProps) {
  const [overdueExpanded, setOverdueExpanded] = useState(true);

  const today = new Date().toISOString().split("T")[0];

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const overdueTasks = useMemo(
    () =>
      tasks.filter(
        (t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < today,
      ),
    [tasks, today],
  );

  const todayTasks = useMemo(
    () => tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today)),
    [tasks, today],
  );

  const totalCount = overdueTasks.length + todayTasks.length;

  const handleReschedule = async () => {
    const todayISO = new Date().toISOString();
    for (const task of overdueTasks) {
      await onUpdateTask(task.id, { dueDate: todayISO });
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <CalendarDays size={24} className="text-accent" />
        <h1 className="text-2xl font-bold text-on-surface">Today</h1>
        <span className="text-sm text-on-surface-muted">
          {new Date().toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </span>
      </div>
      <p className="text-sm text-on-surface-muted mb-6">{totalCount} tasks</p>

      <TaskInput
        onSubmit={onCreateTask}
        placeholder='Add a task for today... (e.g., "buy milk today p1")'
        autoFocusTrigger={autoFocusTrigger}
      />

      {/* Overdue Section */}
      {overdueTasks.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => setOverdueExpanded(!overdueExpanded)}
              className="flex items-center gap-1 text-sm font-semibold text-error hover:text-error/80 transition-colors"
            >
              {overdueExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <AlertTriangle size={14} />
              Overdue
            </button>
            <span className="text-xs text-error font-medium">{overdueTasks.length}</span>
            <button
              onClick={handleReschedule}
              className="ml-auto text-xs text-accent hover:text-accent/80 font-medium transition-colors"
            >
              Reschedule
            </button>
          </div>
          {overdueExpanded && (
            <div className="space-y-0.5">
              {overdueTasks.map((task) => {
                const project = task.projectId ? projectMap.get(task.projectId) : null;
                return (
                  <div
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectTask(task.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectTask(task.id);
                      }
                    }}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                      selectedTaskId === task.id
                        ? "bg-accent/5 ring-1 ring-accent/50"
                        : "hover:bg-surface-secondary"
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleTask(task.id);
                      }}
                      aria-label="Complete task"
                      className="w-5 h-5 rounded-full border-2 border-error flex-shrink-0 transition-colors"
                    />
                    <span className="flex-1 text-sm text-on-surface">{task.title}</span>
                    {project && (
                      <span className="flex items-center gap-1.5 text-xs text-on-surface-muted flex-shrink-0">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: project.color }}
                        />
                        {project.name}
                      </span>
                    )}
                    <span className="text-xs text-error font-medium flex-shrink-0">
                      {new Date(task.dueDate!).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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
        />
      </div>
    </div>
  );
}
