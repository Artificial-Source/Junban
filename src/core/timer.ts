/**
 * In-memory timer for tracking actual task duration.
 * Accumulates elapsed time into task.actualMinutes on stop.
 */

import type { IStorage } from "../storage/interface.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("timer");

interface ActiveTimer {
  taskId: string;
  startedAt: number; // Date.now() timestamp
}

const activeTimers = new Map<string, ActiveTimer>();

/** Start a timer for a task. If already running, this is a no-op. */
export function startTimer(taskId: string): void {
  if (activeTimers.has(taskId)) {
    logger.debug("Timer already running", { taskId });
    return;
  }
  activeTimers.set(taskId, { taskId, startedAt: Date.now() });
  logger.debug("Timer started", { taskId });
}

/**
 * Stop a timer for a task and accumulate elapsed time into actualMinutes.
 * Returns the elapsed minutes added, or 0 if no timer was running.
 */
export function stopTimer(taskId: string, storage: IStorage): number {
  const timer = activeTimers.get(taskId);
  if (!timer) {
    logger.debug("No timer running for task", { taskId });
    return 0;
  }

  const elapsedMs = Date.now() - timer.startedAt;
  const elapsedMinutes = Math.round(elapsedMs / 60000);
  activeTimers.delete(taskId);

  // Accumulate into actualMinutes
  const rows = storage.getTask(taskId);
  if (rows.length > 0) {
    const current = rows[0].actualMinutes ?? 0;
    storage.updateTask(taskId, {
      actualMinutes: current + elapsedMinutes,
      updatedAt: new Date().toISOString(),
    });
    logger.debug("Timer stopped, minutes accumulated", {
      taskId,
      elapsedMinutes,
      total: current + elapsedMinutes,
    });
  }

  return elapsedMinutes;
}

/** Get the active timer for a task, or undefined if not running. */
export function getActiveTimer(taskId: string): ActiveTimer | undefined {
  return activeTimers.get(taskId);
}

/** Check if a timer is currently running for a task. */
export function isTimerRunning(taskId: string): boolean {
  return activeTimers.has(taskId);
}

/** Get elapsed minutes for a running timer (does not stop it). */
export function getElapsedMinutes(taskId: string): number {
  const timer = activeTimers.get(taskId);
  if (!timer) return 0;
  return Math.round((Date.now() - timer.startedAt) / 60000);
}

/** Stop all running timers without saving. Used for cleanup/testing. */
export function clearAllTimers(): void {
  activeTimers.clear();
}

/** Get all currently running task IDs. */
export function getRunningTimerIds(): string[] {
  return Array.from(activeTimers.keys());
}

/**
 * Format a duration in minutes as a human-readable string.
 * Examples: 30 → "30m", 60 → "1h", 90 → "1h 30m", 150 → "2h 30m"
 */
export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Parse an estimate string into minutes.
 * Supports: "30m", "1h", "1.5h", "1h30m", "90m", "2h 15m"
 * Returns null if the string cannot be parsed.
 */
export function parseEstimateString(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Try compound format: 1h30m or 1h 30m
  const compound = trimmed.match(/^(\d+)h\s*(\d+)m$/);
  if (compound) {
    return parseInt(compound[1], 10) * 60 + parseInt(compound[2], 10);
  }

  // Try hours only: 1h, 1.5h
  const hoursOnly = trimmed.match(/^(\d+(?:\.\d+)?)h$/);
  if (hoursOnly) {
    return Math.round(parseFloat(hoursOnly[1]) * 60);
  }

  // Try minutes only: 30m
  const minsOnly = trimmed.match(/^(\d+)m$/);
  if (minsOnly) {
    return parseInt(minsOnly[1], 10);
  }

  // Try plain number (assume minutes)
  const plain = trimmed.match(/^(\d+)$/);
  if (plain) {
    return parseInt(plain[1], 10);
  }

  return null;
}
