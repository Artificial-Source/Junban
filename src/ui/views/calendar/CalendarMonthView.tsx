import { useMemo } from "react";
import { toDateKey } from "../../../utils/format-date.js";
import type { Task, Project } from "../../../core/types.js";

interface CalendarMonthViewProps {
  selectedDate: Date;
  weekStartDay: number;
  tasks: Task[];
  projects: Project[];
  onSelectTask: (id: string) => void;
  onDayClick: (date: Date) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "border-l-red-500",
  2: "border-l-amber-500",
  3: "border-l-accent",
};

const MAX_VISIBLE_TASKS = 3;

function getMonthGrid(year: number, month: number, weekStartDay: number): Date[] {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() - weekStartDay + 7) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);

  // Always 6 rows = 42 cells for consistent height
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  return cells;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarMonthView({
  selectedDate,
  weekStartDay,
  tasks,
  projects,
  onSelectTask,
  onDayClick,
}: CalendarMonthViewProps) {
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const today = toDateKey(new Date());

  const grid = useMemo(() => getMonthGrid(year, month, weekStartDay), [year, month, weekStartDay]);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.dueDate) {
        const key = task.dueDate.split("T")[0];
        const existing = map.get(key);
        if (existing) {
          existing.push(task);
        } else {
          map.set(key, [task]);
        }
      }
    }
    return map;
  }, [tasks]);

  const weekdayHeaders = useMemo(() => {
    const headers: string[] = [];
    for (let i = 0; i < 7; i++) {
      headers.push(WEEKDAY_LABELS[(weekStartDay + i) % 7]);
    }
    return headers;
  }, [weekStartDay]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Weekday header row */}
      <div className="grid grid-cols-7 border-b border-border bg-surface shrink-0">
        {weekdayHeaders.map((label) => (
          <div key={label} className="text-center py-2 text-[10px] uppercase tracking-wider font-medium text-on-surface-muted">
            {label}
          </div>
        ))}
      </div>

      {/* Month grid - 6 rows */}
      <div className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0 overflow-auto">
        {grid.map((day, i) => {
          const key = toDateKey(day);
          const isToday = key === today;
          const isCurrentMonth = day.getMonth() === month;
          const dayTasks = tasksByDay.get(key) ?? [];
          const visibleTasks = dayTasks.slice(0, MAX_VISIBLE_TASKS);
          const overflowCount = dayTasks.length - MAX_VISIBLE_TASKS;

          return (
            <div
              key={i}
              className={`border-r border-b border-border last:border-r-0 p-1 overflow-hidden flex flex-col ${
                isCurrentMonth ? "" : "bg-surface-secondary/30"
              } ${isToday ? "bg-accent/[0.03]" : ""}`}
            >
              {/* Day number */}
              <button
                onClick={() => onDayClick(day)}
                className="flex items-center justify-center mb-0.5 self-start"
              >
                <span className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full transition-colors hover:bg-surface-tertiary ${
                  isToday
                    ? "bg-accent text-white hover:bg-accent-hover"
                    : isCurrentMonth
                      ? "text-on-surface"
                      : "text-on-surface-muted/50"
                }`}>
                  {day.getDate()}
                </span>
              </button>

              {/* Task chips */}
              <div className="space-y-0.5 flex-1 min-h-0 overflow-hidden">
                {visibleTasks.map((task) => {
                  const isCompleted = task.status === "completed";
                  const priorityBorder = !isCompleted && task.priority
                    ? PRIORITY_COLORS[task.priority] ?? "border-l-transparent"
                    : "border-l-transparent";
                  const project = task.projectId ? projectMap.get(task.projectId) : null;

                  return (
                    <button
                      key={task.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectTask(task.id);
                      }}
                      className={`w-full text-left text-[10px] leading-tight px-1 py-0.5 rounded border-l-2 ${priorityBorder} truncate transition-colors ${
                        isCompleted
                          ? "bg-surface-secondary/50 text-on-surface-muted line-through opacity-50"
                          : "bg-surface-secondary hover:bg-surface-tertiary text-on-surface"
                      }`}
                      title={task.title}
                    >
                      <span className="flex items-center gap-0.5">
                        {project && (
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: project.color }}
                          />
                        )}
                        <span className="truncate">{task.title}</span>
                      </span>
                    </button>
                  );
                })}
                {overflowCount > 0 && (
                  <button
                    onClick={() => onDayClick(day)}
                    className="text-[10px] text-accent hover:text-accent-hover px-1 transition-colors"
                  >
                    +{overflowCount} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
