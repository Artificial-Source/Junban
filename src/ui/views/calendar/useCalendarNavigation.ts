import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getWeekStart, toCivilDateKey, type CalendarMode } from "./calendarRange";

interface UseCalendarNavigationOptions {
  initialMode?: CalendarMode;
  weekStartDay?: number;
  /** Confirmed server calendar_default; applied once until the user changes mode. */
  authoritativeMode?: CalendarMode | null;
  onModeChange?: (mode: CalendarMode) => void;
}

export function useCalendarNavigation(options: UseCalendarNavigationOptions = {}) {
  const weekStartDay = options.weekStartDay ?? 0;
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [mode, setModeInternal] = useState<CalendarMode>(options.initialMode ?? "week");
  const manualModeRef = useRef(false);

  const onModeChange = options.onModeChange;
  const setMode = useCallback(
    (next: CalendarMode) => {
      manualModeRef.current = true;
      setModeInternal(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  useEffect(() => {
    if (manualModeRef.current) return;
    if (!options.authoritativeMode) return;
    setModeInternal(options.authoritativeMode);
  }, [options.authoritativeMode]);

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
        case "month": {
          const originalDay = next.getDate();
          next.setDate(1);
          next.setMonth(next.getMonth() + 1);
          const daysInTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
          next.setDate(Math.min(originalDay, daysInTargetMonth));
          break;
        }
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
        case "month": {
          const originalDay = prev.getDate();
          prev.setDate(1);
          prev.setMonth(prev.getMonth() - 1);
          const daysInTargetMonth = new Date(prev.getFullYear(), prev.getMonth() + 1, 0).getDate();
          prev.setDate(Math.min(originalDay, daysInTargetMonth));
          break;
        }
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
        return toCivilDateKey(selectedDate) === toCivilDateKey(now);
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
