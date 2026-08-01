/**
 * Display helpers for Phase 3 planning / weekly-review / nudge facts.
 * Pure formatting only — server responses remain authoritative.
 */

import type {
  CompletionTimeBucketDto,
  NeglectedProjectReasonDto,
  NudgeRuleKindDto,
  WeeklySuggestionDto,
} from "../api/types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Format `YYYY-MM-DD`..`YYYY-MM-DD` like the Weekly Review header. */
export function formatWeekRange(start: string, end: string): string {
  const s = parseCivil(start);
  const e = parseCivil(end);
  if (!s || !e) return `${start} - ${end}`;
  const sMonth = s.toLocaleDateString(undefined, { month: "short" });
  const eMonth = e.toLocaleDateString(undefined, { month: "short" });
  const sDay = s.getDate();
  const eDay = e.getDate();
  if (sMonth === eMonth) return `${sMonth} ${sDay} - ${eDay}`;
  return `${sMonth} ${sDay} - ${eMonth} ${eDay}`;
}

/** Short weekday label for a civil date. */
export function civilDayName(date: string, full = false): string {
  const d = parseCivil(date);
  if (!d) return date;
  return full ? DAY_FULL[d.getDay()]! : DAY_NAMES[d.getDay()]!;
}

export function neglectedReasonLabel(
  reason: NeglectedProjectReasonDto,
  overdueCount: number,
): string {
  if (reason === "overdue_tasks") {
    return overdueCount === 1 ? "1 overdue task" : `${overdueCount} overdue tasks`;
  }
  return "No activity";
}

export function completionBucketLabel(bucket: CompletionTimeBucketDto): string {
  switch (bucket) {
    case "morning":
      return "Morning";
    case "afternoon":
      return "Afternoon";
    case "evening":
      return "Evening";
    case "night":
      return "Night";
    default:
      return bucket;
  }
}

export function weeklySuggestionText(suggestion: WeeklySuggestionDto): string {
  switch (suggestion.kind) {
    case "tackle_overdue":
      return `Tackle ${suggestion.count} overdue task${suggestion.count === 1 ? "" : "s"}.`;
    case "check_neglected":
      return `Check in on ${suggestion.project_ids.length} neglected project${suggestion.project_ids.length === 1 ? "" : "s"}.`;
    case "created_more_than_completed":
      return "You created more tasks than you completed — consider a lighter intake next week.";
    case "keep_streak":
      return `Keep your ${suggestion.days}-day streak going.`;
    default:
      return "Keep going.";
  }
}

export function nudgeMessage(kind: NudgeRuleKindDto, count: number): string {
  switch (kind) {
    case "overdue":
      return count === 1 ? "You have 1 overdue task" : `You have ${count} overdue tasks`;
    case "approaching_deadline":
      return count === 1
        ? "1 task has a deadline approaching"
        : `${count} tasks have deadlines approaching`;
    case "stale_task":
      return count === 1 ? "You have 1 stale task" : `You have ${count} stale tasks`;
    case "empty_today":
      return "Nothing scheduled for today";
    case "overloaded_day":
      return "Today looks overloaded";
    default:
      return "Smart Nudge";
  }
}

/** Nudge href for the primary related view. */
export function nudgeHref(kind: NudgeRuleKindDto): string {
  switch (kind) {
    case "overdue":
    case "empty_today":
    case "overloaded_day":
      return "/";
    case "approaching_deadline":
      return "/upcoming";
    case "stale_task":
      return "/inbox";
    default:
      return "/";
  }
}

function parseCivil(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function formatDurationMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Add days to a civil YYYY-MM-DD string without UTC shifting. */
export function addCivilDays(date: string, days: number): string {
  const d = parseCivil(date);
  if (!d) return date;
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
