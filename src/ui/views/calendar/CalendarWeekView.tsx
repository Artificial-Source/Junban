import { useMemo } from "react";
import { Circle, CheckCircle2 } from "lucide-react";
import { toDateKey } from "../../../utils/format-date.js";
import { getWeekDays } from "./useCalendarNavigation.js";
import type { Task, Project } from "../../../core/types.js";

interface CalendarWeekViewProps {
  selectedDate: Date;
  weekStartDay: number;
  tasks: Task[];
  projects: Project[];
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => void;
  onDayClick: (date: Date) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "border-l-red-500",
  2: "border-l-amber-500",
  3: "border-l-accent",
};

export function CalendarWeekView({
  selectedDate,
  weekStartDay,
  tasks,
  projects,
  onSelectTask,
  onToggleTask,
  onDayClick,
}: CalendarWeekViewProps) {
  const weekDays = useMemo(() => getWeekDays(selectedDate, weekStartDay), [selectedDate, weekStartDay]);
  const today = toDateKey(new Date());

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const day of weekDays) {
      map.set(toDateKey(day), []);
    }
    for (const task of tasks) {
      if (task.dueDate) {
        const key = task.dueDate.split("T")[0];
        if (map.has(key)) {
          map.get(key)!.push(task);
        }
      }
    }
    return map;
  }, [tasks, weekDays]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-border bg-surface shrink-0">
        {weekDays.map((day) => {
          const key = toDateKey(day);
          const isToday = key === today;
          const weekday = day.toLocaleDateString("en-US", { weekday: "short" });
          const dayNum = day.getDate();

          return (
            <button
              key={key}
              onClick={() => onDayClick(day)}
              className={`flex flex-col items-center py-2.5 transition-colors hover:bg-surface-secondary ${
                isToday ? "bg-accent/5" : ""
              }`}
            >
              <span className={`text-[10px] uppercase tracking-wider font-medium ${
                isToday ? "text-accent" : "text-on-surface-muted"
              }`}>
                {weekday}
              </span>
              <span className={`text-lg font-semibold mt-0.5 w-8 h-8 flex items-center justify-center rounded-full ${
                isToday
                  ? "bg-accent text-white"
                  : "text-on-surface"
              }`}>
                {dayNum}
              </span>
            </button>
          );
        })}
      </div>

      {/* Week grid */}
      <div className="grid grid-cols-7 flex-1 min-h-0 overflow-auto">
        {weekDays.map((day) => {
          const key = toDateKey(day);
          const dayTasks = tasksByDay.get(key) ?? [];
          const isToday = key === today;

          return (
            <div
              key={key}
              className={`border-r border-border last:border-r-0 p-1.5 overflow-y-auto ${
                isToday ? "bg-accent/[0.03]" : ""
              }`}
            >
              <div className="space-y-1">
                {dayTasks.map((task) => {
                  const project = task.projectId ? projectMap.get(task.projectId) : null;
                  const isCompleted = task.status === "completed";
                  const priorityBorder = !isCompleted && task.priority
                    ? PRIORITY_COLORS[task.priority] ?? "border-l-transparent"
                    : "border-l-transparent";

                  return (
                    <div
                      key={task.id}
                      className={`group relative rounded-md border-l-2 ${priorityBorder} transition-all ${
                        isCompleted
                          ? "opacity-50"
                          : "hover:shadow-sm"
                      }`}
                    >
                      <button
                        onClick={() => onSelectTask(task.id)}
                        className={`w-full text-left text-[11px] leading-tight px-1.5 py-1.5 rounded-r-md transition-colors ${
                          isCompleted
                            ? "bg-surface-secondary/50"
                            : "bg-surface-secondary hover:bg-surface-tertiary"
                        }`}
                      >
                        <div className="flex items-start gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleTask(task.id);
                            }}
                            className="shrink-0 mt-px text-on-surface-muted hover:text-accent transition-colors"
                          >
                            {isCompleted ? (
                              <CheckCircle2 size={12} className="text-accent" />
                            ) : (
                              <Circle size={12} />
                            )}
                          </button>
                          <span className={`line-clamp-2 ${
                            isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
                          }`}>
                            {task.title}
                          </span>
                        </div>
                        {project && (
                          <div className="flex items-center gap-1 mt-0.5 ml-4">
                            <span
                              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: project.color }}
                            />
                            <span className="text-[10px] text-on-surface-muted truncate">
                              {project.name}
                            </span>
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
