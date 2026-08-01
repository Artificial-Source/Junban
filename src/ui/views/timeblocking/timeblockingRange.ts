/**
 * Pure civil-date/time helpers for Timeblocking.
 * Never route civil_date / start_time / end_time through UTC Date conversion.
 */
import {
  addCivilDays,
  CALENDAR_MAX_RANGE_DAYS,
  parseCivilDate,
  toCivilDateKey,
} from "../calendar/calendarRange";
import { todayKey } from "../../lib/dates";

export type TimeblockingMode = "day" | "week";

/** Phase 3 fixed workday defaults until settings mutations land in Phase 4. */
export const DEFAULT_WORK_DAY_START = "09:00";
export const DEFAULT_WORK_DAY_END = "17:00";
export const DEFAULT_GRID_INTERVAL_MINUTES = 15;
export const DEFAULT_BLOCK_DURATION_MINUTES = 30;
export const MIN_BLOCK_DURATION_MINUTES = 15;
export const TIMEBLOCKING_MAX_RANGE_DAYS = CALENDAR_MAX_RANGE_DAYS;
export const REPLAN_LOOKBACK_DAYS = 7;

export const PIXELS_PER_HOUR_DAY = 80;
export const PIXELS_PER_HOUR_WEEK = 40;

const CIVIL_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** Parse civil wall-clock `HH:MM[:SS]` into minutes from midnight. */
export function civilTimeToMinutes(time: string): number | null {
  const match = CIVIL_TIME.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
  if (hours === 24 && minutes !== 0) return null;
  return hours * 60 + minutes;
}

/** Format minutes-from-midnight as civil `HH:MM` (no UTC path). */
export function minutesToCivilTime(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  const hours = Math.floor(clamped / 60) % 24;
  const minutes = clamped % 60;
  // 24:00 is representable as end-of-day exclusive only; keep HH:MM within 00–23.
  if (clamped >= 24 * 60) return "23:59";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Normalize API `HH:MM[:SS]` to display `HH:MM`. */
export function normalizeCivilTime(time: string): string {
  const minutes = civilTimeToMinutes(time);
  if (minutes === null) return time;
  return minutesToCivilTime(minutes);
}

/** Snap minutes to a positive grid interval (legacy 5/15 behavior via round). */
export function snapToGrid(minutes: number, gridInterval: number): number {
  const step = Math.max(1, gridInterval);
  return Math.round(minutes / step) * step;
}

/**
 * Clamp a start/end pair into the workday, keep end after start, and honor min duration.
 * All values are minutes-from-midnight on one civil day — no 24h UTC arithmetic.
 */
export function clampCivilRange(
  startMinutes: number,
  endMinutes: number,
  workStartMinutes: number,
  workEndMinutes: number,
  options?: { minDuration?: number; gridInterval?: number },
): { start: number; end: number } {
  const minDuration = options?.minDuration ?? MIN_BLOCK_DURATION_MINUTES;
  const grid = options?.gridInterval ?? DEFAULT_GRID_INTERVAL_MINUTES;
  const dayStart = workStartMinutes;
  const dayEnd = Math.max(workStartMinutes + minDuration, workEndMinutes);

  let start = snapToGrid(startMinutes, grid);
  let end = snapToGrid(endMinutes, grid);
  start = Math.max(dayStart, Math.min(start, dayEnd - minDuration));
  end = Math.max(start + minDuration, Math.min(end, dayEnd));
  if (end - start < minDuration) {
    end = Math.min(dayEnd, start + minDuration);
    start = Math.max(dayStart, end - minDuration);
  }
  return { start, end };
}

export function pixelsPerHourForMode(mode: TimeblockingMode): number {
  return mode === "day" ? PIXELS_PER_HOUR_DAY : PIXELS_PER_HOUR_WEEK;
}

export function dayCountForMode(mode: TimeblockingMode): number {
  return mode === "day" ? 1 : 7;
}

/**
 * Inclusive civil range for the Day/Week view.
 * Week is a rolling 7-day window starting at the selected civil day (legacy week mode).
 */
export function timeblockingRequestRange(
  selectedDate: Date,
  mode: TimeblockingMode,
): { from: string; to: string } {
  const from = toCivilDateKey(selectedDate);
  if (mode === "day") return { from, to: from };
  const to = addCivilDays(from, dayCountForMode(mode) - 1);
  return { from, to };
}

/** Prior complete civil days examined by automatic replan: [today-7, yesterday]. */
export function replanLookbackRange(today: string = todayKey()): { from: string; to: string } {
  return {
    from: addCivilDays(today, -REPLAN_LOOKBACK_DAYS),
    to: addCivilDays(today, -1),
  };
}

/** Stable virtual-row key: `{ownerId}:{civil_date}` (matches server occurrence_key). */
export function occurrenceKey(ownerId: string, civilDate: string): string {
  return `${ownerId}:${civilDate}`;
}

export function isVirtualOccurrence(item: {
  recurrence_parent_id?: string | null;
  date: string;
}): boolean {
  return Boolean(item.recurrence_parent_id);
}

/** Owner id used for series mutations (virtual rows keep the owner typed id). */
export function seriesOwnerId(item: { id: string; recurrence_parent_id?: string | null }): string {
  return item.recurrence_parent_id ?? item.id;
}

export function formatHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

export function formatDurationMinutes(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatTimeRangeLabel(start: string, end: string): string {
  return `${normalizeCivilTime(start)} – ${normalizeCivilTime(end)}`;
}

/** Header label matching legacy timeblocking chrome. */
export function formatTimeblockingRangeLabel(selectedDate: Date, mode: TimeblockingMode): string {
  if (mode === "day") {
    return selectedDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  const { from, to } = timeblockingRequestRange(selectedDate, mode);
  const start = parseCivilDate(from);
  const end = parseCivilDate(to);
  if (!start || !end) return from;
  const startStr = start.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const endStr = end.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startStr} \u2013 ${endStr}`;
}

export function civilDatesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  let guard = 0;
  while (guard < TIMEBLOCKING_MAX_RANGE_DAYS) {
    dates.push(cursor);
    if (cursor === to) break;
    cursor = addCivilDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

export function buildHourMarks(
  workStartMinutes: number,
  workEndMinutes: number,
  pixelsPerHour: number,
): Array<{ hour: number; top: number }> {
  const pixelsPerMinute = pixelsPerHour / 60;
  const startHour = Math.floor(workStartMinutes / 60);
  const endHour = Math.ceil(workEndMinutes / 60);
  const marks: Array<{ hour: number; top: number }> = [];
  for (let hour = startHour; hour < endHour; hour += 1) {
    marks.push({
      hour,
      top: (hour * 60 - workStartMinutes) * pixelsPerMinute,
    });
  }
  return marks;
}

export function offsetMinutesFromPointer(
  clientY: number,
  columnTop: number,
  workStartMinutes: number,
  pixelsPerHour: number,
  gridInterval: number,
): number {
  const y = clientY - columnTop;
  const raw = workStartMinutes + (y / pixelsPerHour) * 60;
  return snapToGrid(raw, gridInterval);
}
