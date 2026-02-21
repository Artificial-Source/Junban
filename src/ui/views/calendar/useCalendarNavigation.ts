import { useState, useMemo, useCallback } from "react";
import { useGeneralSettings } from "../../context/SettingsContext.js";

export type CalendarMode = "day" | "week" | "month";

interface UseCalendarNavigationOptions {
  initialMode?: CalendarMode;
  onModeChange?: (mode: CalendarMode) => void;
}

function getWeekStartOffset(weekStart: "sunday" | "monday" | "saturday"): number {
  switch (weekStart) {
    case "sunday": return 0;
    case "monday": return 1;
    case "saturday": return 6;
  }
}

export function useCalendarNavigation(options: UseCalendarNavigationOptions = {}) {
  const { settings } = useGeneralSettings();
  const weekStartDay = getWeekStartOffset(settings.week_start);

  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [mode, setModeInternal] = useState<CalendarMode>(options.initialMode ?? "week");

  const setMode = useCallback(
    (next: CalendarMode) => {
      setModeInternal(next);
      options.onModeChange?.(next);
    },
    [options.onModeChange],
  );

  const goNext = useCallback(() => {
    setSelectedDate((d) => {
      const next = new Date(d);
      switch (mode) {
        case "day":
          next.setDate(next.getDate() + 1);
          break;
        case "week":
          next.setDate(next.getDate() + 7);
          break;
        case "month":
          next.setMonth(next.getMonth() + 1);
          break;
      }
      return next;
    });
  }, [mode]);

  const goPrev = useCallback(() => {
    setSelectedDate((d) => {
      const prev = new Date(d);
      switch (mode) {
        case "day":
          prev.setDate(prev.getDate() - 1);
          break;
        case "week":
          prev.setDate(prev.getDate() - 7);
          break;
        case "month":
          prev.setMonth(prev.getMonth() - 1);
          break;
      }
      return prev;
    });
  }, [mode]);

  const goToday = useCallback(() => {
    setSelectedDate(new Date());
  }, []);

  const setDate = useCallback((d: Date) => {
    setSelectedDate(new Date(d));
  }, []);

  const isCurrentPeriod = useMemo(() => {
    const now = new Date();
    switch (mode) {
      case "day":
        return (
          selectedDate.getFullYear() === now.getFullYear() &&
          selectedDate.getMonth() === now.getMonth() &&
          selectedDate.getDate() === now.getDate()
        );
      case "week": {
        const weekStart = getWeekStart(selectedDate, weekStartDay);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const todayTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        return todayTime >= weekStart.getTime() && todayTime <= weekEnd.getTime();
      }
      case "month":
        return (
          selectedDate.getFullYear() === now.getFullYear() &&
          selectedDate.getMonth() === now.getMonth()
        );
    }
  }, [selectedDate, mode, weekStartDay]);

  const periodLabel = useMemo(() => {
    switch (mode) {
      case "day":
        return selectedDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      case "week": {
        const weekStart = getWeekStart(selectedDate, weekStartDay);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
        if (weekStart.getFullYear() !== weekEnd.getFullYear()) {
          return `${weekStart.toLocaleDateString("en-US", { ...opts, year: "numeric" })} – ${weekEnd.toLocaleDateString("en-US", { ...opts, year: "numeric" })}`;
        }
        if (weekStart.getMonth() !== weekEnd.getMonth()) {
          return `${weekStart.toLocaleDateString("en-US", opts)} – ${weekEnd.toLocaleDateString("en-US", opts)}, ${weekStart.getFullYear()}`;
        }
        return `${weekStart.toLocaleDateString("en-US", { month: "long" })} ${weekStart.getDate()}–${weekEnd.getDate()}, ${weekStart.getFullYear()}`;
      }
      case "month":
        return selectedDate.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        });
    }
  }, [selectedDate, mode, weekStartDay]);

  return {
    selectedDate,
    mode,
    setMode,
    goNext,
    goPrev,
    goToday,
    setDate,
    isCurrentPeriod,
    periodLabel,
    weekStartDay,
  };
}

/** Get the start of the week containing `date`, respecting the given weekStartDay (0=Sun,1=Mon,6=Sat). */
export function getWeekStart(date: Date, weekStartDay: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (d.getDay() - weekStartDay + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

/** Get all 7 days of the week containing `date`. */
export function getWeekDays(date: Date, weekStartDay: number): Date[] {
  const start = getWeekStart(date, weekStartDay);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    days.push(day);
  }
  return days;
}
