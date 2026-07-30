/**
 * Completed-view history grouping. Cancelled rows fall back to updated_at when
 * completed_at is null (same rule as the Cancelled view).
 */
import type { TaskDto } from "../api/client";
import { calendarDayKey } from "../lib/dates";

export function historyTimestamp(task: Pick<TaskDto, "completed_at" | "updated_at">): string {
  return task.completed_at ?? task.updated_at;
}

export function sortCompletedHistory<T extends Pick<TaskDto, "completed_at" | "updated_at">>(
  tasks: T[],
): T[] {
  return [...tasks].sort((a, b) => historyTimestamp(b).localeCompare(historyTimestamp(a)));
}

export function groupCompletedHistory<T extends Pick<TaskDto, "completed_at" | "updated_at">>(
  tasks: T[],
): { date: string; tasks: T[] }[] {
  const sorted = sortCompletedHistory(tasks);
  const groups: { date: string; tasks: T[] }[] = [];
  let currentDate = "";
  let currentGroup: T[] = [];
  for (const task of sorted) {
    const day = calendarDayKey(historyTimestamp(task)) ?? "unknown";
    if (day !== currentDate) {
      if (currentGroup.length > 0) groups.push({ date: currentDate, tasks: currentGroup });
      currentDate = day;
      currentGroup = [task];
    } else {
      currentGroup.push(task);
    }
  }
  if (currentGroup.length > 0) groups.push({ date: currentDate, tasks: currentGroup });
  return groups;
}
