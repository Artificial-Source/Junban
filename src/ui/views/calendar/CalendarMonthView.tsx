import { useMemo, useState } from "react";
import type { ProjectDto, TaskDto } from "../../api/client";
import {
  getMonthGrid,
  groupTasksByDueDate,
  toCivilDateKey,
  todayKey as civilToday,
} from "./calendarRange";

interface CalendarMonthViewProps {
  selectedDate: Date;
  weekStartDay: number;
  tasks: TaskDto[];
  projects: ProjectDto[];
  onSelectTask: (id: string) => void;
  onDayClick: (date: Date) => void;
  onDropTaskOnDay: (taskId: string, dueDate: string) => Promise<boolean>;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "border-l-red-500",
  2: "border-l-amber-500",
  3: "border-l-accent-action",
};

const MAX_VISIBLE_TASKS = 3;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarMonthView({
  selectedDate,
  weekStartDay,
  tasks,
  projects,
  onSelectTask,
  onDayClick,
  onDropTaskOnDay,
}: CalendarMonthViewProps) {
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const today = civilToday();
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const grid = useMemo(() => getMonthGrid(year, month, weekStartDay), [year, month, weekStartDay]);

  const projectMap = useMemo(() => {
    const map = new Map<string, ProjectDto>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const tasksByDay = useMemo(() => groupTasksByDueDate(tasks), [tasks]);

  const weekdayHeaders = useMemo(() => {
    const headers: string[] = [];
    for (let i = 0; i < 7; i++) {
      headers.push(WEEKDAY_LABELS[(weekStartDay + i) % 7]!);
    }
    return headers;
  }, [weekStartDay]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className="flex min-w-[700px] flex-1 flex-col md:min-w-0">
        <div className="sticky top-0 z-10 grid shrink-0 grid-cols-7 border-b border-border bg-surface">
          {weekdayHeaders.map((label) => (
            <div
              key={label}
              className="py-2.5 text-center text-xs font-medium uppercase tracking-wider text-on-surface-muted md:py-2 md:text-[10px]"
            >
              {label}
            </div>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-auto">
          {grid.map((day, i) => {
            const key = toCivilDateKey(day);
            const isToday = key === today;
            const isCurrentMonth = day.getMonth() === month;
            const dayTasks = tasksByDay.get(key) ?? [];
            const visibleTasks = dayTasks.slice(0, MAX_VISIBLE_TASKS);
            const overflowCount = dayTasks.length - MAX_VISIBLE_TASKS;

            return (
              <div
                key={i}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverKey(key);
                }}
                onDragLeave={() => setDragOverKey((current) => (current === key ? null : current))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverKey(null);
                  const taskId =
                    e.dataTransfer.getData("text/junban-task-id") ||
                    e.dataTransfer.getData("text/plain");
                  if (!taskId) return;
                  void onDropTaskOnDay(taskId, key);
                }}
                className={`flex flex-col overflow-hidden border-r border-b border-border p-1.5 last:border-r-0 md:p-1 ${
                  isCurrentMonth ? "" : "bg-surface-secondary/30"
                } ${isToday ? "bg-accent-action/[0.03]" : ""} ${
                  dragOverKey === key ? "ring-2 ring-inset ring-accent-action/40" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => onDayClick(day)}
                  className="mb-0.5 flex min-h-[32px] min-w-[32px] items-center justify-center self-start md:min-h-0 md:min-w-0"
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium transition-colors hover:bg-surface-tertiary md:h-6 md:w-6 md:text-xs ${
                      isToday
                        ? "bg-accent-action text-on-accent-action hover:bg-accent-action-hover"
                        : isCurrentMonth
                          ? "text-on-surface"
                          : "text-on-surface-muted/50"
                    }`}
                  >
                    {day.getDate()}
                  </span>
                </button>

                <div className="min-h-0 flex-1 space-y-1 overflow-hidden md:space-y-0.5">
                  {visibleTasks.map((task) => {
                    const isCompleted = task.status === "completed";
                    const priorityBorder =
                      !isCompleted && task.priority
                        ? (PRIORITY_COLORS[task.priority] ?? "border-l-transparent")
                        : "border-l-transparent";
                    const project = task.project_id ? projectMap.get(task.project_id) : null;

                    return (
                      <button
                        key={task.id}
                        type="button"
                        draggable={!isCompleted}
                        onDragStart={(e) => {
                          if (isCompleted) return;
                          e.dataTransfer.setData("text/junban-task-id", task.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectTask(task.id);
                        }}
                        className={`min-h-[28px] w-full truncate rounded border-l-2 px-1.5 py-1.5 text-left text-xs leading-tight transition-colors md:min-h-0 md:px-1 md:py-0.5 md:text-[10px] ${priorityBorder} ${
                          isCompleted
                            ? "bg-surface-secondary/50 text-on-surface-muted line-through opacity-50"
                            : "bg-surface-secondary text-on-surface hover:bg-surface-tertiary"
                        }`}
                        title={task.title}
                      >
                        <span className="flex items-center gap-1 md:gap-0.5">
                          {project && (
                            <span
                              className="inline-block h-2 w-2 shrink-0 rounded-full md:h-1.5 md:w-1.5"
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
                      type="button"
                      onClick={() => onDayClick(day)}
                      className="min-h-[28px] px-1 py-1 text-xs text-accent-foreground transition-colors hover:text-accent-foreground-hover md:min-h-0 md:py-0 md:text-[10px]"
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
    </div>
  );
}
