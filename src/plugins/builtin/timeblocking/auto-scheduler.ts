/**
 * Auto-scheduling engine for the timeblocking plugin.
 * Scores tasks by priority, urgency, and energy fit, then greedily packs them
 * into available time gaps during work hours.
 *
 * All functions are pure except `applySchedule`, which writes to the store.
 */

import type { TimeBlock } from "./types.js";
import type { TimeBlockStore } from "./store.js";
import type { Task } from "../../../core/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tuning knobs for the scheduling algorithm. */
export interface SchedulerSettings {
  workDayStart: string; // "HH:mm"
  workDayEnd: string; // "HH:mm"
  gridIntervalMinutes: number;
  defaultDurationMinutes: number;
  bufferMinutes: number;
}

/** A task annotated with its composite scheduling score. */
export interface ScoredTask {
  task: Task;
  priorityScore: number;
  urgencyScore: number;
  energyScore: number;
  composite: number;
  estimatedMinutes: number;
}

/** A gap of free time in the work day. */
export interface TimeGap {
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
}

/** A proposed (not yet committed) time block. */
export interface ProposedBlock {
  taskId: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  score: number;
}

/** A warning emitted when a task cannot be fully scheduled. */
export interface ScheduleWarning {
  taskId: string;
  title: string;
  reason: string;
}

/** The complete output of the scheduling algorithm. */
export interface ProposedSchedule {
  proposed: ProposedBlock[];
  warnings: ScheduleWarning[];
  totalScheduledMinutes: number;
  totalRequestedMinutes: number;
}

/** Input to the auto-scheduler. */
export interface ScheduleRequest {
  tasks: Task[];
  existingBlocks: TimeBlock[];
  date: string;
  settings: SchedulerSettings;
  referenceDate?: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeStr(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Snap a minute value down to the nearest grid boundary. */
function snapToGrid(minutes: number, grid: number): number {
  return Math.floor(minutes / grid) * grid;
}

/** Snap a minute value up to the nearest grid boundary. */
function snapUpToGrid(minutes: number, grid: number): number {
  return Math.ceil(minutes / grid) * grid;
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

const PRIORITY_WEIGHTS: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1 };

/**
 * Score tasks for scheduling. Higher score = higher scheduling priority.
 *
 * Composite = priority * 0.4 + urgency * 0.35 + energy * 0.25
 * All sub-scores are normalized to [0, 1] before weighting.
 */
export function scoreTasks(tasks: Task[], referenceDate: Date = new Date()): ScoredTask[] {
  const refTime = referenceDate.getTime();

  return tasks
    .map((task) => {
      // Priority: p1=4, p2=3, p3=2, p4=1, none=1 — normalize to [0,1] by /4
      const rawPriority = PRIORITY_WEIGHTS[task.priority ?? 4] ?? 1;
      const priorityScore = rawPriority / 4;

      // Urgency: exponential curve based on due date proximity
      let urgencyScore = 0.2; // default for tasks with no due date
      if (task.dueDate) {
        const dueTime = new Date(task.dueDate).getTime();
        const daysUntilDue = (dueTime - refTime) / (1000 * 60 * 60 * 24);
        if (daysUntilDue <= 0) {
          // Overdue
          urgencyScore = 1.0;
        } else if (daysUntilDue <= 1) {
          urgencyScore = 0.9;
        } else if (daysUntilDue <= 3) {
          urgencyScore = 0.7;
        } else if (daysUntilDue <= 7) {
          urgencyScore = 0.4;
        } else {
          // Exponential decay: further out = lower urgency
          urgencyScore = Math.max(0.1, 0.4 * Math.exp(-0.1 * (daysUntilDue - 7)));
        }
      }

      // Energy fit: high priority ("dread") tasks get morning boost, low priority get afternoon.
      // Score represents how well a task fits the "schedule early" heuristic.
      // High-dread (p1/p2) get higher energy score; they'll be placed in earlier gaps.
      const energyScore = (task.priority ?? 4) <= 2 ? 0.9 : 0.3;

      const composite = priorityScore * 0.4 + urgencyScore * 0.35 + energyScore * 0.25;
      const estimatedMinutes = task.estimatedMinutes ?? 30;

      return {
        task,
        priorityScore,
        urgencyScore,
        energyScore,
        composite,
        estimatedMinutes,
      };
    })
    .sort((a, b) => {
      // Primary: descending composite. Secondary: stable by task id.
      if (b.composite !== a.composite) return b.composite - a.composite;
      return a.task.id.localeCompare(b.task.id);
    });
}

// ---------------------------------------------------------------------------
// Gap finding
// ---------------------------------------------------------------------------

/**
 * Find available time gaps between existing blocks within work hours.
 * Blocks outside work hours are ignored.
 */
export function findAvailableGaps(
  existingBlocks: TimeBlock[],
  workDayStart: string,
  workDayEnd: string,
  date: string,
): TimeGap[] {
  const workStart = parseTimeToMinutes(workDayStart);
  const workEnd = parseTimeToMinutes(workDayEnd);

  if (workStart >= workEnd) return [];

  // Filter to blocks on the target date and clamp to work hours
  const intervals = existingBlocks
    .filter((b) => b.date === date)
    .map((b) => ({
      start: Math.max(parseTimeToMinutes(b.startTime), workStart),
      end: Math.min(parseTimeToMinutes(b.endTime), workEnd),
    }))
    .filter((i) => i.start < i.end)
    .sort((a, b) => a.start - b.start);

  // Merge overlapping intervals
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    if (merged.length > 0 && interval.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  // Extract gaps
  const gaps: TimeGap[] = [];
  let cursor = workStart;
  for (const interval of merged) {
    if (interval.start > cursor) {
      const duration = interval.start - cursor;
      gaps.push({ startMinutes: cursor, endMinutes: interval.start, durationMinutes: duration });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < workEnd) {
    gaps.push({ startMinutes: cursor, endMinutes: workEnd, durationMinutes: workEnd - cursor });
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Greedy scheduling
// ---------------------------------------------------------------------------

/**
 * Auto-schedule tasks into available gaps.
 *
 * Strategy: score tasks, find gaps, greedily pack highest-scored tasks first.
 * High-dread tasks go into earlier gaps; low-dread into later gaps.
 */
export function autoSchedule(request: ScheduleRequest): ProposedSchedule {
  const { tasks, existingBlocks, date, settings, referenceDate } = request;

  if (tasks.length === 0) {
    return { proposed: [], warnings: [], totalScheduledMinutes: 0, totalRequestedMinutes: 0 };
  }

  const scored = scoreTasks(tasks, referenceDate ?? new Date());
  const gaps = findAvailableGaps(existingBlocks, settings.workDayStart, settings.workDayEnd, date);

  const proposed: ProposedBlock[] = [];
  const warnings: ScheduleWarning[] = [];
  let totalScheduledMinutes = 0;
  let totalRequestedMinutes = 0;

  // Track remaining capacity per gap
  const gapCursors = gaps.map((g) => ({
    startMinutes: g.startMinutes,
    endMinutes: g.endMinutes,
    cursor: g.startMinutes,
  }));

  for (const scored_task of scored) {
    const { task, composite, estimatedMinutes } = scored_task;
    const duration = Math.max(estimatedMinutes, settings.gridIntervalMinutes);
    totalRequestedMinutes += duration;

    // High-dread (energy score >= 0.9) tasks scan gaps from start.
    // Low-dread tasks scan gaps from end.
    const isHighDread = scored_task.energyScore >= 0.9;
    const gapOrder = isHighDread
      ? gapCursors
      : [...gapCursors].reverse();

    let placed = false;
    for (const gap of gapOrder) {
      const available = gap.endMinutes - gap.cursor;
      if (available < settings.gridIntervalMinutes) continue;

      const effectiveDuration = Math.min(duration, available);
      if (effectiveDuration < settings.gridIntervalMinutes) continue;

      const snappedStart = snapUpToGrid(gap.cursor, settings.gridIntervalMinutes);
      if (snappedStart >= gap.endMinutes) continue;

      const snappedEnd = snapToGrid(
        Math.min(snappedStart + effectiveDuration, gap.endMinutes),
        settings.gridIntervalMinutes,
      );
      if (snappedEnd <= snappedStart) continue;
      if (snappedEnd - snappedStart < settings.gridIntervalMinutes) continue;

      proposed.push({
        taskId: task.id,
        title: task.title,
        date,
        startTime: minutesToTimeStr(snappedStart),
        endTime: minutesToTimeStr(snappedEnd),
        score: composite,
      });

      // Advance gap cursor past placed block + buffer
      gap.cursor = snappedEnd + settings.bufferMinutes;
      totalScheduledMinutes += snappedEnd - snappedStart;
      placed = true;

      if (effectiveDuration < duration) {
        warnings.push({
          taskId: task.id,
          title: task.title,
          reason: `Only ${effectiveDuration}min of ${duration}min estimated could be scheduled`,
        });
      }

      break;
    }

    if (!placed) {
      warnings.push({
        taskId: task.id,
        title: task.title,
        reason: "No available time gap large enough",
      });
    }
  }

  // Sort proposed blocks chronologically
  proposed.sort((a, b) => a.startTime.localeCompare(b.startTime));

  return { proposed, warnings, totalScheduledMinutes, totalRequestedMinutes };
}

// ---------------------------------------------------------------------------
// Apply to store
// ---------------------------------------------------------------------------

/**
 * Convert proposed blocks into real TimeBlocks via the store.
 * Returns the created block IDs.
 */
export async function applySchedule(
  proposed: ProposedBlock[],
  store: TimeBlockStore,
): Promise<string[]> {
  const ids: string[] = [];
  for (const p of proposed) {
    const block = await store.createBlock({
      title: p.title,
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      taskId: p.taskId,
      locked: false,
    });
    ids.push(block.id);
  }
  return ids;
}
