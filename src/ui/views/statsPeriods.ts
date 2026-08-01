/**
 * Pure stats period range helpers. Aggregates come only from the server response.
 */
import { addCivilDays, toCivilDateKey } from "./calendar/calendarRange";
import type { DailyStatBucketDto, StatsResponse } from "../api/client";

export type StatsPeriod = "7d" | "30d" | "90d" | "1y" | "custom";

export const STATS_PERIOD_OPTIONS: { value: StatsPeriod; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "1y", label: "1y" },
  { value: "custom", label: "Custom" },
];

/** Inclusive civil range for a named period ending on `today` (YYYY-MM-DD). */
export function statsPeriodRange(
  period: Exclude<StatsPeriod, "custom">,
  today: string,
): { from: string; to: string } {
  switch (period) {
    case "7d":
      return { from: addCivilDays(today, -6), to: today };
    case "30d":
      return { from: addCivilDays(today, -29), to: today };
    case "90d":
      return { from: addCivilDays(today, -89), to: today };
    case "1y":
      return { from: addCivilDays(today, -364), to: today };
  }
}

/** Completions on a single civil day from server buckets. */
export function completionsOnDay(days: DailyStatBucketDto[], day: string): number {
  return days.find((d) => d.date === day)?.completions ?? 0;
}

/** Sum completions for days in [from, to] inclusive from server buckets only. */
export function completionsInRange(days: DailyStatBucketDto[], from: string, to: string): number {
  let total = 0;
  for (const day of days) {
    if (day.date >= from && day.date <= to) total += day.completions;
  }
  return total;
}

/** Monday-based week start for the "This Week" card (display helper only). */
export function weekStartMonday(today: string): string {
  const date = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  return toCivilDateKey(date);
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function chartRowsWithToday(
  stats: StatsResponse,
  today: string,
): { key: string; label: string; count: number; isToday: boolean }[] {
  return stats.days.map((day) => {
    const date = new Date(
      Number(day.date.slice(0, 4)),
      Number(day.date.slice(5, 7)) - 1,
      Number(day.date.slice(8, 10)),
    );
    return {
      key: day.date,
      label: WEEKDAY_LABELS[date.getDay()] ?? day.date,
      count: day.completions,
      isToday: day.date === today,
    };
  });
}
