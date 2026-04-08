import { useEffect, useRef, useCallback } from "react";
import { fetchDueReminders, updateTask } from "../api/tasks.js";

interface UseRemindersOptions {
  onReminder: (task: { id: string; title: string }) => void;
  enabled?: boolean;
  intervalMs?: number;
}

/**
 * Polls for due reminders and fires callbacks for each.
 * Clears remindAt on fired tasks to prevent re-firing.
 */
export function useReminders({
  onReminder,
  enabled = true,
  intervalMs = 60000,
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

        // Clear the reminder so it doesn't re-fire
        updateTask(task.id, { remindAt: null }).catch(() => {
          // Non-critical — reminder will fire again on next poll
        });
      }
    } catch {
      // Non-critical
    }
  }, [enabled, onReminder]);

  useEffect(() => {
    if (!enabled) return;

    // Initial check
    checkReminders();

    const timer = setInterval(checkReminders, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, checkReminders]);
}
