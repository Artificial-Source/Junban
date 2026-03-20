import type { TimeBlock } from "../types.js";
import { formatDateStr, timeToMinutes } from "../components/TimelineColumn.js";

export type ViewMode = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const VIEW_MODE_LABELS: Array<{ value: ViewMode; label: string }> = [
  { value: 1, label: "Day" },
  { value: 3, label: "3D" },
  { value: 5, label: "5D" },
  { value: 7, label: "Week" },
];

/** Pixels per hour for the timeline grid — wider columns when fewer days are shown. */
const PX_PER_HOUR_1DAY = 80;
const PX_PER_HOUR_2_3DAY = 64;
const PX_PER_HOUR_4_5DAY = 48;
const PX_PER_HOUR_WEEK = 40;

export function getPixelsPerHour(dayCount: ViewMode): number {
  if (dayCount === 1) return PX_PER_HOUR_1DAY;
  if (dayCount <= 3) return PX_PER_HOUR_2_3DAY;
  if (dayCount <= 5) return PX_PER_HOUR_4_5DAY;
  return PX_PER_HOUR_WEEK;
}

export function formatDateRange(startDate: Date, dayCount: number): string {
  if (dayCount === 1) {
    return startDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + dayCount - 1);
  const startStr = startDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const endStr = endDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startStr} \u2013 ${endStr}`;
}

export function getDateRangeStrings(startDate: Date, dayCount: number): { startStr: string; endStr: string } {
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + dayCount - 1);
  return { startStr: formatDateStr(startDate), endStr: formatDateStr(endDate) };
}

/** Find the currently active block (current time falls within its range). */
export function findActiveBlock(blocks: TimeBlock[]): TimeBlock | null {
  const now = new Date();
  const todayStr = formatDateStr(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return blocks.find(
    (b) =>
      b.date === todayStr &&
      nowMinutes >= timeToMinutes(b.startTime) &&
      nowMinutes < timeToMinutes(b.endTime),
  ) ?? null;
}

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 280;
