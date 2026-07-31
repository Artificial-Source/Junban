import { useMemo, useState } from "react";
import type { ProjectDto, TaskDto } from "../../api/client";
import { CalendarTaskCard } from "./CalendarTaskCard";
import {
  getWeekDays,
  groupTasksByDueDate,
  toCivilDateKey,
  todayKey as civilToday,
} from "./calendarRange";

const SHORT_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

interface CalendarWeekViewProps {
  selectedDate: Date;
  weekStartDay: number;
  tasks: TaskDto[];
  projects: ProjectDto[];
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => Promise<boolean>;
  onDayClick: (date: Date) => void;
  onDropTaskOnDay: (taskId: string, dueDate: string) => Promise<boolean>;
  onDragStart?: (taskId: string) => void;
}

export function CalendarWeekView({
  selectedDate,
  weekStartDay,
  tasks,
  projects,
  onSelectTask,
  onToggleTask,
  onDayClick,
  onDropTaskOnDay,
  onDragStart,
}: CalendarWeekViewProps) {
  const weekDays = useMemo(
    () => getWeekDays(selectedDate, weekStartDay),
    [selectedDate, weekStartDay],
  );
  const today = civilToday();
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const projectMap = useMemo(() => {
    const map = new Map<string, ProjectDto>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const tasksByDay = useMemo(() => {
    const grouped = groupTasksByDueDate(tasks);
    const map = new Map<string, TaskDto[]>();
    for (const day of weekDays) {
      const key = toCivilDateKey(day);
      map.set(key, grouped.get(key) ?? []);
    }
    return map;
  }, [tasks, weekDays]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className="flex min-w-[700px] flex-1 flex-col md:min-w-0">
        <div className="sticky top-0 z-10 grid shrink-0 grid-cols-7 border-b border-border bg-surface">
          {weekDays.map((day) => {
            const key = toCivilDateKey(day);
            const isToday = key === today;
            const weekday = SHORT_WEEKDAY_FORMATTER.format(day);
            const fullDate = FULL_DATE_FORMATTER.format(day);
            const dayNum = day.getDate();

            return (
              <button
                key={key}
                type="button"
                aria-label={`View ${fullDate}`}
                onClick={() => onDayClick(day)}
                className={`flex min-h-[56px] flex-col items-center py-3 transition-colors hover:bg-surface-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus md:min-h-0 md:py-2.5 ${
                  isToday ? "bg-accent-action/5" : ""
                }`}
              >
                <span
                  className={`text-xs font-medium uppercase tracking-wider md:text-[10px] ${
                    isToday ? "text-accent-foreground" : "text-on-surface-muted"
                  }`}
                >
                  {weekday}
                </span>
                <span
                  className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full text-lg font-semibold ${
                    isToday ? "bg-accent-action text-on-accent-action" : "text-on-surface"
                  }`}
                >
                  {dayNum}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-7 overflow-auto">
          {weekDays.map((day) => {
            const key = toCivilDateKey(day);
            const dayTasks = tasksByDay.get(key) ?? [];
            const isToday = key === today;
            const fullDate = FULL_DATE_FORMATTER.format(day);

            return (
              <section
                key={key}
                aria-label={fullDate}
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
                className={`overflow-y-auto border-r border-border p-2 last:border-r-0 md:p-1.5 ${
                  isToday ? "bg-accent-action/[0.03]" : ""
                } ${dragOverKey === key ? "ring-2 ring-inset ring-accent-action/40" : ""}`}
              >
                <div className="space-y-1.5 md:space-y-1">
                  {dayTasks.map((task) => (
                    <CalendarTaskCard
                      key={task.id}
                      task={task}
                      project={task.project_id ? (projectMap.get(task.project_id) ?? null) : null}
                      onSelectTask={onSelectTask}
                      onToggleTask={onToggleTask}
                      onDragStart={onDragStart}
                      size="week"
                      draggable
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
