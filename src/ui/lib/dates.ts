/** Date utilities that preserve date-only YYYY-MM-DD values without timezone shifts. */

import {
  getConfirmedDateFormat,
  getConfirmedTimeFormat,
  type DateFormatPreference,
  type TimeFormatPreference,
} from "./dateTimePreferences";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a strict YYYY-MM-DD calendar date. */
export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, day);
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

/**
 * Return the calendar day key for a date-only or instant value.
 * Date-only YYYY-MM-DD values are never timezone-shifted.
 * Instant values (ISO 8601 with time) are classified in the browser's local calendar.
 */
export function calendarDayKey(value: string): string | null {
  if (DATE_ONLY_PATTERN.test(value)) {
    return isValidDateOnly(value) ? value : null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Return the browser's local civil day as a YYYY-MM-DD string. */
export function todayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function localDateFromInput(dateStr: string): Date | null {
  if (DATE_ONLY_PATTERN.test(dateStr)) {
    if (!isValidDateOnly(dateStr)) return null;
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Format a YYYY-MM-DD date using the confirmed date_format preference (default Short). */
export function formatDate(
  dateStr: string,
  now: Date = new Date(),
  format: DateFormatPreference = getConfirmedDateFormat(),
): string {
  if (format === "relative") {
    return formatRelativeDate(dateStr, now);
  }
  if (format === "iso") {
    return calendarDayKey(dateStr) ?? dateStr;
  }
  const date = localDateFromInput(dateStr);
  if (!date) return dateStr;
  if (format === "long") return formatLongDate(date);
  // short — preserves prior toLocaleDateString behavior
  return formatShortDate(date);
}

/** Format a relative date label (Today, Yesterday, Tomorrow, weekday, or date). */
export function formatRelativeDate(dateStr: string, now: Date = new Date()): string {
  const day = calendarDayKey(dateStr);
  if (day === null) return dateStr;

  const today = todayKey(now);
  if (day === today) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === todayKey(yesterday)) return "Yesterday";

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day === todayKey(tomorrow)) return "Tomorrow";

  const [year, month, dayNum] = day.split("-").map(Number);
  const date = new Date(year, month - 1, dayNum);
  const diffDays = Math.ceil(
    (date.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  if (diffDays > 1 && diffDays <= 6) {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Format a civil wall-clock `HH:MM[:SS]` for display using confirmed time_format. */
export function formatCivilTime(
  time: string,
  format: TimeFormatPreference = getConfirmedTimeFormat(),
): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = match[2]!;
  if (format === "h24") return `${match[1]}:${minute}`;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12Value = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12Value}:${minute} ${suffix}`;
}

/** Format an ISO timestamp's local wall time using confirmed time_format. */
export function formatTimestampTime(
  isoStr: string,
  format: TimeFormatPreference = getConfirmedTimeFormat(),
): string {
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return isoStr;
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: format === "h12",
  });
}

/** Format the Today header string, e.g. "Jul 23 · Today · Thursday". */
export function formatTodayHeader(now: Date = new Date()): string {
  const month = now.toLocaleDateString(undefined, { month: "short" });
  const day = now.getDate();
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  return `${month} ${day} · Today · ${weekday}`;
}
