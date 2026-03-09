import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { evaluateNudges, type Nudge, type NudgeType } from "../../core/nudges.js";
import type { Task } from "../../core/types.js";
import { toDateKey } from "../../utils/format-date.js";
import type { GeneralSettings } from "../context/SettingsContext.js";

interface UseNudgesOptions {
  tasks: Task[];
  settings: GeneralSettings;
  intervalMs?: number;
}

interface UseNudgesResult {
  activeNudges: Nudge[];
  dismiss: (id: string) => void;
}

const _NUDGE_TYPE_SETTINGS: Record<NudgeType, keyof GeneralSettings> = {
  overdue_alert: "nudge_overdue_alert",
  deadline_approaching: "nudge_deadline_approaching",
  stale_tasks: "nudge_stale_tasks",
  empty_today: "nudge_empty_today",
  overloaded_day: "nudge_overloaded_day",
};

/**
 * Evaluates nudge rules periodically from existing task state.
 * No API calls — purely derived from in-memory data.
 * Session-scoped dismissed set prevents re-showing dismissed nudges.
 */
export function useNudges({
  tasks,
  settings,
  intervalMs = 300000, // 5 minutes
}: UseNudgesOptions): UseNudgesResult {
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const dismissedRef = useRef<Set<string>>(new Set());

  const enabled = settings.nudge_enabled === "true";
  const capacityMinutes = settings.daily_capacity_minutes;

  // Depend on individual setting values (not the settings object) for stable references
  const nudgeOverdue = settings.nudge_overdue_alert;
  const nudgeDeadline = settings.nudge_deadline_approaching;
  const nudgeStale = settings.nudge_stale_tasks;
  const nudgeEmpty = settings.nudge_empty_today;
  const nudgeOverloaded = settings.nudge_overloaded_day;

  const enabledTypes = useMemo(() => {
    const types = new Set<NudgeType>();
    if (!enabled) return types;
    if (nudgeOverdue === "true") types.add("overdue_alert");
    if (nudgeDeadline === "true") types.add("deadline_approaching");
    if (nudgeStale === "true") types.add("stale_tasks");
    if (nudgeEmpty === "true") types.add("empty_today");
    if (nudgeOverloaded === "true") types.add("overloaded_day");
    return types;
  }, [enabled, nudgeOverdue, nudgeDeadline, nudgeStale, nudgeEmpty, nudgeOverloaded]);

  const evaluate = useCallback(() => {
    if (!enabled || enabledTypes.size === 0) {
      setNudges([]);
      return;
    }

    const todayKey = toDateKey(new Date());
    const cap = parseInt(capacityMinutes, 10) || 480;

    const all = evaluateNudges({
      tasks,
      todayKey,
      capacityMinutes: cap,
      enabledTypes,
    });

    const active = all.filter((n) => !dismissedRef.current.has(n.id));
    setNudges(active);
  }, [tasks, enabled, enabledTypes, capacityMinutes]);

  // Evaluate on mount + interval
  useEffect(() => {
    evaluate();

    if (!enabled) return;

    const timer = setInterval(evaluate, intervalMs);
    return () => clearInterval(timer);
  }, [evaluate, enabled, intervalMs]);

  const dismiss = useCallback((id: string) => {
    dismissedRef.current.add(id);
    setNudges((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { activeNudges: nudges, dismiss };
}
