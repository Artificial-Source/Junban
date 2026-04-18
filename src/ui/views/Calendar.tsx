import { useEffect, useMemo } from "react";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { SegmentedControl } from "./settings/components.js";
import { useCalendarNavigation, type CalendarMode } from "./calendar/useCalendarNavigation.js";
import { CalendarWeekView } from "./calendar/CalendarWeekView.js";
import { CalendarMonthView } from "./calendar/CalendarMonthView.js";
import { CalendarDayView } from "./calendar/CalendarDayView.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { toDateKey } from "../../utils/format-date.js";
import type { Task, Project } from "../../core/types.js";

interface CalendarProps {
  tasks: Task[];
  projects: Project[];
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
  mode?: CalendarMode | null;
  onModeChange?: (mode: CalendarMode) => void;
}

export function Calendar({
  tasks,
  projects,
  onSelectTask,
  onToggleTask,
  mode: modeProp,
  onModeChange,
}: CalendarProps) {
  const { settings } = useGeneralSettings();
  const defaultMode = settings.calendar_default_mode as CalendarMode | undefined;

  const nav = useCalendarNavigation({
    initialMode: modeProp ?? defaultMode ?? "week",
    onModeChange,
  });

  // Sync mode from route prop and reset date to today
  useEffect(() => {
    if (modeProp && modeProp !== nav.mode) {
      nav.setMode(modeProp);
      nav.setDate(new Date());
    }
  }, [modeProp, nav]);

  const taskCount = useMemo(() => {
    if (nav.mode === "day") {
      const key = toDateKey(nav.selectedDate);
      return tasks.filter((t) => t.dueDate?.startsWith(key)).length;
    }
    // For week/month, show total visible tasks (approximate for month)
    return tasks.filter((t) => t.dueDate).length;
  }, [tasks, nav.mode, nav.selectedDate]);

  const handleDayClick = (date: Date) => {
    nav.setDate(date);
    nav.setMode("day");
  };

  return (
    <div className="flex flex-col h-full -m-3 md:-m-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 md:px-6 py-3 border-b border-border bg-surface shrink-0">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <CalendarRange size={22} className="text-accent shrink-0" />
          <h1 className="text-base md:text-lg font-semibold text-on-surface truncate">
            {nav.periodLabel}
          </h1>
          {nav.mode === "day" && taskCount > 0 && (
            <span className="text-xs text-on-surface-muted bg-surface-secondary px-2 py-0.5 rounded-full shrink-0">
              {taskCount} task{taskCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            options={[
              { value: "day" as CalendarMode, label: "Day" },
              { value: "week" as CalendarMode, label: "Week" },
              { value: "month" as CalendarMode, label: "Month" },
            ]}
            value={nav.mode}
            onChange={nav.setMode}
          />
          <div className="flex items-center gap-1 ml-1 md:ml-2">
            <button
              onClick={nav.goPrev}
              aria-label={`Previous ${nav.mode}`}
              className="p-2 md:p-1.5 rounded-lg hover:bg-surface-secondary transition-colors text-on-surface-muted hover:text-on-surface"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              onClick={nav.goToday}
              className={`px-3 py-1.5 md:py-1 text-sm font-medium rounded-lg transition-colors ${
                nav.isCurrentPeriod
                  ? "bg-accent/10 text-accent"
                  : "hover:bg-surface-secondary text-on-surface-muted hover:text-on-surface"
              }`}
            >
              Today
            </button>
            <button
              onClick={nav.goNext}
              aria-label={`Next ${nav.mode}`}
              className="p-2 md:p-1.5 rounded-lg hover:bg-surface-secondary transition-colors text-on-surface-muted hover:text-on-surface"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Active sub-view */}
      <div key={nav.mode} className="flex-1 min-h-0 flex flex-col animate-fade-in">
        {nav.mode === "week" && (
          <CalendarWeekView
            selectedDate={nav.selectedDate}
            weekStartDay={nav.weekStartDay}
            tasks={tasks}
            projects={projects}
            onSelectTask={onSelectTask}
            onToggleTask={onToggleTask}
            onDayClick={handleDayClick}
          />
        )}
        {nav.mode === "month" && (
          <CalendarMonthView
            selectedDate={nav.selectedDate}
            weekStartDay={nav.weekStartDay}
            tasks={tasks}
            projects={projects}
            onSelectTask={onSelectTask}
            onDayClick={handleDayClick}
          />
        )}
        {nav.mode === "day" && (
          <CalendarDayView
            selectedDate={nav.selectedDate}
            tasks={tasks}
            projects={projects}
            onSelectTask={onSelectTask}
            onToggleTask={onToggleTask}
          />
        )}
      </div>
    </div>
  );
}
