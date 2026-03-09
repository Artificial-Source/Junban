import type { RecurrenceRule } from "./types.js";

/**
 * Expand a recurring item into concrete instances for a date range.
 * Each instance gets a deterministic ID (`${parentId}_${date}`) and
 * `recurrenceParentId` pointing to the original.
 */
export function expandRecurrence<
  T extends { id: string; date: string; recurrenceRule?: RecurrenceRule },
>(item: T, rangeStart: string, rangeEnd: string): T[] {
  const rule = item.recurrenceRule;
  if (!rule) return [];

  const results: T[] = [];
  const start = new Date(rangeStart + "T00:00:00");
  const end = new Date(rangeEnd + "T00:00:00");
  const itemDate = new Date(item.date + "T00:00:00");
  const ruleEnd = rule.endDate ? new Date(rule.endDate + "T00:00:00") : null;

  if (start > end) return [];

  const candidates = generateDates(itemDate, rule, start, end, ruleEnd);

  for (const date of candidates) {
    const dateStr = formatDate(date);
    // Skip the original item's date — it's the parent, not an instance
    if (dateStr === item.date) continue;

    results.push({
      ...item,
      id: `${item.id}_${dateStr}`,
      date: dateStr,
      recurrenceRule: undefined,
      recurrenceParentId: item.id,
    } as T);
  }

  return results;
}

function generateDates(
  origin: Date,
  rule: RecurrenceRule,
  rangeStart: Date,
  rangeEnd: Date,
  ruleEnd: Date | null,
): Date[] {
  const dates: Date[] = [];
  const effectiveEnd = ruleEnd && ruleEnd < rangeEnd ? ruleEnd : rangeEnd;

  switch (rule.frequency) {
    case "daily":
      return generateDaily(origin, rule.interval, rangeStart, effectiveEnd);
    case "weekly":
      return generateWeekly(origin, rule.interval, rule.daysOfWeek ?? [origin.getDay()], rangeStart, effectiveEnd);
    case "monthly":
      return generateMonthly(origin, rule.interval, rangeStart, effectiveEnd);
  }

  return dates;
}

function generateDaily(origin: Date, interval: number, rangeStart: Date, rangeEnd: Date): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(origin);

  // Advance cursor to the first occurrence at or after rangeStart
  if (cursor < rangeStart) {
    const daysDiff = Math.floor((rangeStart.getTime() - cursor.getTime()) / 86400000);
    const skip = Math.floor(daysDiff / interval) * interval;
    cursor.setDate(cursor.getDate() + skip);
    if (cursor < rangeStart) {
      cursor.setDate(cursor.getDate() + interval);
    }
  }

  while (cursor <= rangeEnd) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + interval);
  }

  return dates;
}

function generateWeekly(
  origin: Date,
  interval: number,
  daysOfWeek: number[],
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  const dates: Date[] = [];
  const sortedDays = [...daysOfWeek].sort((a, b) => a - b);

  // Find the start of the origin's week (Sunday)
  const originWeekStart = new Date(origin);
  originWeekStart.setDate(originWeekStart.getDate() - originWeekStart.getDay());

  // Find how many weeks from origin week start to rangeStart
  const cursor = new Date(originWeekStart);
  if (cursor < rangeStart) {
    const daysDiff = Math.floor((rangeStart.getTime() - cursor.getTime()) / 86400000);
    const weeksDiff = Math.floor(daysDiff / 7);
    const skipWeeks = Math.floor(weeksDiff / interval) * interval;
    cursor.setDate(cursor.getDate() + skipWeeks * 7);
  }

  while (cursor <= rangeEnd) {
    for (const dow of sortedDays) {
      const candidate = new Date(cursor);
      candidate.setDate(candidate.getDate() + dow);
      if (candidate >= rangeStart && candidate <= rangeEnd && candidate >= origin) {
        dates.push(candidate);
      }
    }
    cursor.setDate(cursor.getDate() + interval * 7);
  }

  return dates;
}

function generateMonthly(origin: Date, interval: number, rangeStart: Date, rangeEnd: Date): Date[] {
  const dates: Date[] = [];
  const targetDay = origin.getDate();

  // Start from origin's month
  let year = origin.getFullYear();
  let month = origin.getMonth();

  // Advance to rangeStart
  if (new Date(year, month + 1, 0) < rangeStart) {
    const monthsDiff =
      (rangeStart.getFullYear() - year) * 12 + (rangeStart.getMonth() - month);
    const skip = Math.floor(monthsDiff / interval) * interval;
    month += skip;
    year += Math.floor(month / 12);
    month = month % 12;
  }

  const maxIterations = 1000;
  let iterations = 0;
  while (iterations++ < maxIterations) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    if (targetDay <= daysInMonth) {
      const candidate = new Date(year, month, targetDay);
      if (candidate > rangeEnd) break;
      if (candidate >= rangeStart && candidate >= origin) {
        dates.push(candidate);
      }
    }
    month += interval;
    if (month >= 12) {
      year += Math.floor(month / 12);
      month = month % 12;
    }
  }

  return dates;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
