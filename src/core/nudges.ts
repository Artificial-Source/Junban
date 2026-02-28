import type { Task } from "./types.js";

export type NudgeSeverity = "info" | "warning";

export type NudgeType =
  | "overdue_alert"
  | "deadline_approaching"
  | "stale_tasks"
  | "empty_today"
  | "overloaded_day";

export interface Nudge {
  id: string;
  type: NudgeType;
  message: string;
  severity: NudgeSeverity;
  taskIds?: string[];
}

export interface NudgeContext {
  tasks: Task[];
  todayKey: string;
  capacityMinutes: number;
  enabledTypes: Set<NudgeType>;
}

/** Days before a task is considered stale. */
const STALE_THRESHOLD_DAYS = 14;
/** Max stale tasks to report. */
const MAX_STALE_NUDGES = 3;

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(dateKey: string, todayKey: string): number {
  const a = new Date(dateKey + "T00:00:00");
  const b = new Date(todayKey + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Evaluate all nudge rules against the given context.
 * Pure function — no side effects, no API calls.
 */
export function evaluateNudges(ctx: NudgeContext): Nudge[] {
  const nudges: Nudge[] = [];
  const pending = ctx.tasks.filter((t) => t.status === "pending");

  // ── overdue_alert ──
  if (ctx.enabledTypes.has("overdue_alert")) {
    const overdue = pending.filter(
      (t) => t.dueDate && t.dueDate.slice(0, 10) < ctx.todayKey,
    );
    if (overdue.length > 0) {
      nudges.push({
        id: `overdue_alert:${ctx.todayKey}`,
        type: "overdue_alert",
        message:
          overdue.length === 1
            ? "You have 1 overdue task"
            : `You have ${overdue.length} overdue tasks`,
        severity: "warning",
        taskIds: overdue.map((t) => t.id),
      });
    }
  }

  // ── deadline_approaching ──
  if (ctx.enabledTypes.has("deadline_approaching")) {
    const tomorrow = new Date(ctx.todayKey + "T00:00:00");
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = toDateKey(tomorrow);

    const approaching = pending.filter(
      (t) =>
        t.deadline &&
        t.deadline.slice(0, 10) >= ctx.todayKey &&
        t.deadline.slice(0, 10) <= tomorrowKey,
    );
    for (const task of approaching) {
      const isToday = task.deadline!.slice(0, 10) === ctx.todayKey;
      nudges.push({
        id: `deadline_approaching:${task.id}`,
        type: "deadline_approaching",
        message: isToday
          ? `"${task.title}" deadline is today`
          : `"${task.title}" deadline is tomorrow`,
        severity: "warning",
        taskIds: [task.id],
      });
    }
  }

  // ── stale_tasks ──
  if (ctx.enabledTypes.has("stale_tasks")) {
    const stale = pending
      .filter((t) => {
        if (t.dueDate) return false; // has a date, not stale
        const created = t.createdAt.slice(0, 10);
        return daysBetween(created, ctx.todayKey) >= STALE_THRESHOLD_DAYS;
      })
      .slice(0, MAX_STALE_NUDGES);

    for (const task of stale) {
      const days = daysBetween(task.createdAt.slice(0, 10), ctx.todayKey);
      nudges.push({
        id: `stale_tasks:${task.id}`,
        type: "stale_tasks",
        message: `"${task.title}" has been pending for ${days} days`,
        severity: "info",
        taskIds: [task.id],
      });
    }
  }

  // ── empty_today ──
  if (ctx.enabledTypes.has("empty_today")) {
    const todayTasks = pending.filter(
      (t) => t.dueDate && t.dueDate.slice(0, 10) === ctx.todayKey,
    );
    if (todayTasks.length === 0) {
      nudges.push({
        id: `empty_today:${ctx.todayKey}`,
        type: "empty_today",
        message: "No tasks planned for today",
        severity: "info",
      });
    }
  }

  // ── overloaded_day ──
  if (ctx.enabledTypes.has("overloaded_day")) {
    const todayAndOverdue = pending.filter(
      (t) => t.dueDate && t.dueDate.slice(0, 10) <= ctx.todayKey,
    );
    const totalMinutes = todayAndOverdue.reduce(
      (sum, t) => sum + (t.estimatedMinutes ?? 0),
      0,
    );
    if (totalMinutes > ctx.capacityMinutes) {
      const totalHours = Math.round(totalMinutes / 60);
      const overHours = Math.round((totalMinutes - ctx.capacityMinutes) / 60);
      nudges.push({
        id: `overloaded_day:${ctx.todayKey}`,
        type: "overloaded_day",
        message: `Today has ${totalHours}h of work (${overHours}h over capacity)`,
        severity: "warning",
      });
    }
  }

  return nudges;
}
