import { useEffect, useRef, useCallback } from "react";
import { fetchDueReminders, updateTask } from "../api/tasks.js";

const INITIAL_REMINDERS_CHECK_DELAY_MS = 1500;

interface UseRemindersOptions {
  onReminder: (task: { id: string; title: string }) => void;
  enabled?: boolean;
  intervalMs?: number;
  clearReminders?: boolean;
}

/**
 * Polls for due reminders and fires callbacks for each.
 * Optionally clears remindAt on fired tasks to prevent re-firing.
 */
export function useReminders({
  onReminder,
  enabled = true,
  intervalMs = 60000,
  clearReminders = true,
}: UseRemindersOptions) {
  const firedRef = useRef<Set<string>>(new Set());

  const checkReminders = useCallback(async () => {
    if (!enabled) return;

    try {
      const dueTasks = await fetchDueReminders();
      for (const task of dueTasks) {
        if (firedRef.current.has(task.id)) continue;
        firedRef.current.add(task.id);

        onReminder({ id: task.id, title: task.title });

        if (clearReminders) {
          // Clear the reminder so it doesn't re-fire
          updateTask(task.id, { remindAt: null }).catch(() => {
            // Non-critical — reminder will fire again on next poll
          });
        }
      }
    } catch {
      // Non-critical
    }
  }, [enabled, onReminder, clearReminders]);

  useEffect(() => {
    if (!enabled) return;

    let intervalHandle: ReturnType<typeof globalThis.setInterval> | null = null;

    const startPolling = () => {
      if (intervalHandle !== null) return;
      intervalHandle = globalThis.setInterval(() => {
        void checkReminders();
      }, intervalMs);
    };

    const scheduleInitialCheck = () => {
      void checkReminders();
      startPolling();
    };

    const timeoutHandle = globalThis.setTimeout(
      scheduleInitialCheck,
      INITIAL_REMINDERS_CHECK_DELAY_MS,
    );

    return () => {
      globalThis.clearTimeout(timeoutHandle);
      if (intervalHandle !== null) {
        globalThis.clearInterval(intervalHandle);
      }
    };
  }, [enabled, intervalMs, checkReminders]);
}
