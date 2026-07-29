/** Date utilities that preserve date-only YYYY-MM-DD values without timezone shifts. */

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

/** Format a YYYY-MM-DD date for display using local date interpretation (no UTC shift). */
export function formatDate(dateStr: string): string {
  if (DATE_ONLY_PATTERN.test(dateStr)) {
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString();
  }
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString();
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

/** Format the Today header string, e.g. "Jul 23 · Today · Thursday". */
export function formatTodayHeader(now: Date = new Date()): string {
  const month = now.toLocaleDateString(undefined, { month: "short" });
  const day = now.getDate();
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  return `${month} ${day} · Today · ${weekday}`;
}
