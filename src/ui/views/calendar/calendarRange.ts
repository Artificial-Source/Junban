/**
 * Pure civil-date helpers for Calendar range requests and day grouping.
 * Date-only YYYY-MM-DD values are never shifted through UTC.
 */
import { calendarDayKey, isValidDateOnly, todayKey } from "../../lib/dates";
import type { TaskDto } from "../../api/client";

export { todayKey };

export type CalendarMode = "day" | "week" | "month";

/** Inclusive civil day span bound for calendar and timeblocking reads. */
export const CALENDAR_MAX_RANGE_DAYS = 42;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Format a local Date as a civil YYYY-MM-DD key without UTC conversion. */
export function toCivilDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Parse a civil YYYY-MM-DD into a local Date at local midnight. */
export function parseCivilDate(key: string): Date | null {
  if (!isValidDateOnly(key)) return null;
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Add whole civil days to a YYYY-MM-DD key. */
export function addCivilDays(key: string, days: number): string {
  const date = parseCivilDate(key);
  if (!date) return key;
  date.setDate(date.getDate() + days);
  return toCivilDateKey(date);
}

/** Inclusive day count between two civil keys (from/to). */
export function inclusiveDayCount(from: string, to: string): number {
  const start = parseCivilDate(from);
  const end = parseCivilDate(to);
  if (!start || !end) return 0;
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

export function getWeekStart(date: Date, weekStartDay: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (d.getDay() - weekStartDay + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

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

/** Always 42 cells (6 weeks) for stable month layout height. */
export function getMonthGrid(year: number, month: number, weekStartDay: number): Date[] {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() - weekStartDay + 7) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  return cells;
}

/**
 * Compute the inclusive civil range the Calendar view should request.
 * Month mode uses the full 42-day grid; never exceeds CALENDAR_MAX_RANGE_DAYS.
 */
export function calendarRequestRange(
  selectedDate: Date,
  mode: CalendarMode,
  weekStartDay: number,
): { from: string; to: string } {
  if (mode === "day") {
    const key = toCivilDateKey(selectedDate);
    return { from: key, to: key };
  }
  if (mode === "week") {
    const days = getWeekDays(selectedDate, weekStartDay);
    return { from: toCivilDateKey(days[0]!), to: toCivilDateKey(days[6]!) };
  }
  const grid = getMonthGrid(selectedDate.getFullYear(), selectedDate.getMonth(), weekStartDay);
  return { from: toCivilDateKey(grid[0]!), to: toCivilDateKey(grid[41]!) };
}

/**
 * Group tasks by civil `due_date` only.
 * Instant timestamps are never used for day assignment — date-only semantics win.
 */
export function groupTasksByDueDate(tasks: TaskDto[]): Map<string, TaskDto[]> {
  const map = new Map<string, TaskDto[]>();
  for (const task of tasks) {
    if (!task.due_date) continue;
    // Prefer exact civil date-only; never shift through UTC for YYYY-MM-DD.
    const key =
      DATE_ONLY.test(task.due_date) && isValidDateOnly(task.due_date)
        ? task.due_date
        : calendarDayKey(task.due_date);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(task);
    else map.set(key, [task]);
  }
  return map;
}

/** Split one day's tasks into all-day (no due_time) and timed. */
export function splitDayTasks(tasks: TaskDto[]): {
  allDayTasks: TaskDto[];
  timedTasks: TaskDto[];
} {
  const allDayTasks: TaskDto[] = [];
  const timedTasks: TaskDto[] = [];
  for (const task of tasks) {
    if (task.due_time?.time) timedTasks.push(task);
    else allDayTasks.push(task);
  }
  timedTasks.sort((a, b) => {
    const at = a.due_time?.time ?? "";
    const bt = b.due_time?.time ?? "";
    return at.localeCompare(bt);
  });
  return { allDayTasks, timedTasks };
}

/** Format a civil wall-clock `HH:MM[:SS]` for display. */
export function formatCivilTime(time: string, hour12 = true): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = match[2]!;
  if (!hour12) return `${match[1]}:${minute}`;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12Value = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12Value}:${minute} ${suffix}`;
}

export function isTodayCivil(key: string, now: Date = new Date()): boolean {
  return key === todayKey(now);
}
