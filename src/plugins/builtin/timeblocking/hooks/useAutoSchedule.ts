/**
 * Hook that manages auto-schedule preview state and actions.
 * Handles generating proposals, applying them, and cancellation.
 */

import { useState, useCallback } from "react";
import type { TimeBlockStore } from "../store.js";
import type { Task } from "../../../../core/types.js";
import {
  autoSchedule,
  applySchedule,
  type ProposedSchedule,
  type SchedulerSettings,
} from "../auto-scheduler.js";

interface UseAutoScheduleParams {
  store: TimeBlockStore;
  tasks: Task[];
  selectedDate: Date;
  workDayStart: string;
  workDayEnd: string;
  gridInterval: number;
  defaultDuration: number;
  refreshData: () => void;
}

interface UseAutoScheduleReturn {
  /** The current schedule preview, or null if not previewing. */
  preview: ProposedSchedule | null;
  /** Whether an apply operation is in progress. */
  isApplying: boolean;
  /** Generate a schedule preview for the selected date. */
  generatePreview: () => void;
  /** Apply the current preview, creating real blocks. */
  applyPreview: () => Promise<void>;
  /** Cancel the current preview. */
  cancelPreview: () => void;
}

function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function useAutoSchedule({
  store,
  tasks,
  selectedDate,
  workDayStart,
  workDayEnd,
  gridInterval,
  defaultDuration,
  refreshData,
}: UseAutoScheduleParams): UseAutoScheduleReturn {
  const [preview, setPreview] = useState<ProposedSchedule | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const generatePreview = useCallback(() => {
    const dateStr = formatDateStr(selectedDate);
    const existingBlocks = store.listBlocks(dateStr);

    // Only schedule pending tasks that aren't already on this date
    const scheduledTaskIds = new Set(
      existingBlocks.map((b) => b.taskId).filter(Boolean),
    );
    const pendingTasks = tasks.filter(
      (t) => t.status === "pending" && !scheduledTaskIds.has(t.id),
    );

    const settings: SchedulerSettings = {
      workDayStart,
      workDayEnd,
      gridIntervalMinutes: gridInterval,
      defaultDurationMinutes: defaultDuration,
      bufferMinutes: 5,
    };

    const result = autoSchedule({
      tasks: pendingTasks,
      existingBlocks,
      date: dateStr,
      settings,
    });

    setPreview(result);
  }, [store, tasks, selectedDate, workDayStart, workDayEnd, gridInterval, defaultDuration]);

  const applyPreview = useCallback(async () => {
    if (!preview) return;
    setIsApplying(true);
    try {
      await applySchedule(preview.proposed, store);
      setPreview(null);
      refreshData();
    } finally {
      setIsApplying(false);
    }
  }, [preview, store, refreshData]);

  const cancelPreview = useCallback(() => {
    setPreview(null);
  }, []);

  return { preview, isApplying, generatePreview, applyPreview, cancelPreview };
}
