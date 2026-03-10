import { useMemo } from "react";
import { Circle, CheckCircle2, CalendarOff } from "lucide-react";
import { toDateKey, formatTaskTime } from "../../../utils/format-date.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";
import { EmptyState } from "../../components/EmptyState.js";
import type { Task, Project } from "../../../core/types.js";

interface CalendarDayViewProps {
  selectedDate: Date;
  tasks: Task[];
  projects: Project[];
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "border-l-red-500",
  2: "border-l-amber-500",
  3: "border-l-accent",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

const PRIORITY_TAG_COLORS: Record<number, string> = {
  1: "bg-red-500/10 text-red-500",
  2: "bg-amber-500/10 text-amber-500",
  3: "bg-blue-500/10 text-accent",
  4: "bg-surface-tertiary text-on-surface-muted",
};

export function CalendarDayView({
  selectedDate,
  tasks,
  projects,
  onSelectTask,
  onToggleTask,
}: CalendarDayViewProps) {
  const { settings } = useGeneralSettings();
  const dateKey = toDateKey(selectedDate);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const dayTasks = useMemo(
    () => tasks.filter((t) => t.dueDate?.startsWith(dateKey)),
    [tasks, dateKey],
  );

  const { allDayTasks, timedTasks } = useMemo(() => {
    const allDay: Task[] = [];
    const timed: Task[] = [];
    for (const task of dayTasks) {
      if (task.dueTime && task.dueDate) {
        timed.push(task);
      } else {
        allDay.push(task);
      }
    }
    // Sort timed tasks by their due date/time
    timed.sort((a, b) => (a.dueDate! > b.dueDate! ? 1 : -1));
    return { allDayTasks: allDay, timedTasks: timed };
  }, [dayTasks]);

  if (dayTasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<CalendarOff size={40} />}
          title="No tasks for this day"
          description="Tasks with a due date on this day will appear here"
        />
      </div>
    );
  }

  const renderTaskCard = (task: Task) => {
    const project = task.projectId ? projectMap.get(task.projectId) : null;
    const isCompleted = task.status === "completed";
    const priorityBorder =
      !isCompleted && task.priority
        ? (PRIORITY_COLORS[task.priority] ?? "border-l-transparent")
        : "border-l-transparent";

    return (
      <div
        key={task.id}
        className={`group rounded-lg border-l-3 ${priorityBorder} transition-all ${
          isCompleted ? "opacity-50" : "hover:shadow-md"
        }`}
      >
        <button
          onClick={() => onSelectTask(task.id)}
          className={`w-full text-left px-3 py-2.5 rounded-r-lg transition-colors ${
            isCompleted
              ? "bg-surface-secondary/50"
              : "bg-surface-secondary hover:bg-surface-tertiary"
          }`}
        >
          <div className="flex items-start gap-2">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onToggleTask(task.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleTask(task.id);
                }
              }}
              className="shrink-0 mt-0.5 text-on-surface-muted hover:text-accent transition-colors cursor-pointer"
            >
              {isCompleted ? (
                <CheckCircle2 size={18} className="text-accent" />
              ) : (
                <Circle size={18} />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <span
                className={`text-sm ${
                  isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
                }`}
              >
                {task.title}
              </span>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {task.dueTime && task.dueDate && (
                  <span className="text-xs text-on-surface-muted">
                    {formatTaskTime(task.dueDate, settings.time_format)}
                  </span>
                )}
                {project && (
                  <span className="flex items-center gap-1 text-xs text-on-surface-muted">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                    {project.name}
                  </span>
                )}
                {!isCompleted && task.priority && (
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      PRIORITY_TAG_COLORS[task.priority] ?? ""
                    }`}
                  >
                    {PRIORITY_LABELS[task.priority]}
                  </span>
                )}
                {task.tags.length > 0 && (
                  <span className="text-xs text-on-surface-muted">
                    {task.tags.map((t) => `#${t.name}`).join(" ")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </button>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 space-y-6">
      {/* All-day tasks */}
      {allDayTasks.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wider font-medium text-on-surface-muted mb-2">
            All Day
          </h3>
          <div className="space-y-1.5">{allDayTasks.map(renderTaskCard)}</div>
        </section>
      )}

      {/* Timed tasks */}
      {timedTasks.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wider font-medium text-on-surface-muted mb-2">
            Scheduled
          </h3>
          <div className="space-y-1.5">{timedTasks.map(renderTaskCard)}</div>
        </section>
      )}
    </div>
  );
}
