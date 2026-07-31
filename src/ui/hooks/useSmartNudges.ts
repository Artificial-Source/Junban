/**
 * Smart Nudge client.
 * Fetches Rust `/nudges` once per app load / civil date and after relevant
 * mutation/SSE invalidation (workspace revision). Dismissal is session-local
 * only — never durable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getNudges, getTemporalSettings, type NudgeRuleKindDto } from "../api/client";
import { useWorkspace } from "../context/WorkspaceContext";
import { useToday } from "./useToday";
import { nudgeMessage } from "../lib/planningLabels";

export type ActiveNudge = {
  id: string;
  kind: NudgeRuleKindDto;
  message: string;
  taskIds: string[];
};

export function useSmartNudges({ enabled = true }: { enabled?: boolean } = {}): {
  activeNudges: ActiveNudge[];
  dismiss: (id: string) => void;
} {
  const today = useToday();
  const { revision, showToast } = useWorkspace();
  const [nudges, setNudges] = useState<ActiveNudge[]>([]);
  const dismissedRef = useRef(new Set<string>());
  const shownRef = useRef<string | null>(null);
  const lastFetchKeyRef = useRef<string | null>(null);
  const enabledRef = useRef(true);

  const applyRules = useCallback(
    (rules: { kind: NudgeRuleKindDto; task_ids: string[]; has_more: boolean }[]) => {
      const next: ActiveNudge[] = [];
      for (const rule of rules) {
        const id = rule.kind;
        if (dismissedRef.current.has(id)) continue;
        // empty_today may have zero task ids; still show when present.
        const count = Math.max(rule.task_ids.length, rule.kind === "empty_today" ? 1 : 0);
        if (rule.kind !== "empty_today" && rule.task_ids.length === 0) continue;
        next.push({
          id,
          kind: rule.kind,
          message: nudgeMessage(rule.kind, count),
          taskIds: rule.task_ids,
        });
      }
      setNudges(next);
    },
    [],
  );

  const fetchNudges = useCallback(async () => {
    try {
      const settings = await getTemporalSettings();
      enabledRef.current = settings.nudges_enabled;
      if (!settings.nudges_enabled) {
        setNudges([]);
        return;
      }
      const response = await getNudges();
      applyRules(response.rules);
    } catch {
      // Soft-fail: do not block the shell on nudge transport errors.
    }
  }, [applyRules]);

  // Fetch once per civil day and whenever the workspace revision moves.
  useEffect(() => {
    if (!enabled) {
      setNudges([]);
      return;
    }
    const key = `${today}:${revision}`;
    if (lastFetchKeyRef.current === key) return;
    lastFetchKeyRef.current = key;
    void fetchNudges();
  }, [enabled, today, revision, fetchNudges]);

  const dismiss = useCallback((id: string) => {
    dismissedRef.current.add(id);
    setNudges((prev) => prev.filter((n) => n.id !== id));
    if (shownRef.current === id) shownRef.current = null;
  }, []);

  // Surface one nudge toast at a time (legacy behaviour).
  useEffect(() => {
    if (nudges.length === 0) {
      shownRef.current = null;
      return;
    }
    const next = nudges[0]!;
    if (shownRef.current === next.id) return;
    shownRef.current = next.id;
    showToast("info", next.message, {
      inverted: true,
      durationMs: 8000,
      action: {
        label: "Dismiss",
        onClick: () => dismiss(next.id),
      },
    });
    const timer = setTimeout(() => dismiss(next.id), 8000);
    return () => clearTimeout(timer);
  }, [nudges, showToast, dismiss]);

  return { activeNudges: nudges, dismiss };
}
