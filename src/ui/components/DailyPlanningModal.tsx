/**
 * Plan My Day ritual — full-shell modal over Rust `/planning/daily` facts.
 * Session exclusions and focus selection (max 3) are client-local; mutations
 * are awaited task PATCHes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ListChecks, Clock, Rocket } from "lucide-react";
import { ApiError, getDailyPlan, type DailyPlanResponse, type TaskDto } from "../api/client";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useToday } from "../hooks/useToday";
import { formatDurationMinutes } from "../lib/planningLabels";
import { useWorkspace } from "../context/WorkspaceContext";

const MAX_FOCUS = 3;
const PENDING_DISMISS_MESSAGE =
  "Save in progress. Wait for it to finish before closing the daily plan.";

const STEPS = [
  { icon: AlertTriangle, title: "Review Overdue" },
  { icon: ListChecks, title: "Today's Focus" },
  { icon: Clock, title: "Time Budget" },
  { icon: Rocket, title: "Ready!" },
] as const;

interface DailyPlanningModalProps {
  open: boolean;
  onClose: () => void;
}

export function DailyPlanningModal({ open, onClose }: DailyPlanningModalProps) {
  const today = useToday();
  const { catalog } = useWorkspace();
  const { patchTask } = useTaskMutations();
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<DailyPlanResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [estimates, setEstimates] = useState<Map<string, number>>(() => new Map());
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open);

  const projectName = useCallback(
    (projectId: string | null | undefined) => {
      if (!projectId || !catalog) return null;
      return catalog.projects.find((p) => p.id === projectId)?.name ?? null;
    },
    [catalog],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await getDailyPlan();
      setPlan(response);
      const focus = response.focus_tasks;
      const initial = new Set<string>();
      for (const task of focus) {
        if (initial.size >= MAX_FOCUS) break;
        initial.add(task.id);
      }
      setSelectedIds(initial);
      setExcludedIds(new Set());
      setEstimates(new Map());
      setStep(0);
      setError(null);
    } catch (caught) {
      setPlan(null);
      setLoadError(caught instanceof ApiError ? caught.message : "Could not load the daily plan.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const requestDismiss = useCallback(() => {
    if (pendingRef.current) {
      setError(PENDING_DISMISS_MESSAGE);
      return;
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      requestDismiss();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, requestDismiss]);

  const overdueTasks = plan?.overdue_tasks ?? [];
  const focusCandidates = useMemo(() => {
    if (!plan) return [] as TaskDto[];
    return plan.focus_tasks.filter((t) => !excludedIds.has(t.id));
  }, [plan, excludedIds]);

  const selectedTasks = useMemo(
    () => focusCandidates.filter((t) => selectedIds.has(t.id)),
    [focusCandidates, selectedIds],
  );

  const capacityMinutes = plan?.capacity_minutes ?? 480;
  const totalPlanned = useMemo(
    () =>
      selectedTasks.reduce((sum, t) => sum + (estimates.get(t.id) ?? t.estimated_minutes ?? 0), 0),
    [selectedTasks, estimates],
  );

  const runMutation = useCallback(async (action: () => Promise<unknown>, failure: string) => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result === null) {
        setError(failure);
        return false;
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);

  const handleReschedule = useCallback(
    async (taskId: string) => {
      const ok = await runMutation(
        () => patchTask(taskId, { due_date: today }, "Reschedule to today"),
        "The task could not be rescheduled.",
      );
      if (ok) await load();
    },
    [load, patchTask, runMutation, today],
  );

  const handleAllToToday = useCallback(async () => {
    if (!plan || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      for (const task of plan.overdue_tasks) {
        const result = await patchTask(task.id, { due_date: today }, "Reschedule to today");
        if (result === null) {
          setError("Could not move every overdue task to today.");
          return;
        }
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not move overdue tasks.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [load, patchTask, plan, today]);

  const handleSetAside = useCallback((taskId: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const handleToggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
        return next;
      }
      if (next.size >= MAX_FOCUS) {
        setError(`Select up to ${MAX_FOCUS} focus tasks.`);
        return prev;
      }
      setError(null);
      next.add(taskId);
      return next;
    });
  }, []);

  const handleFinish = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      for (const [id, mins] of estimates) {
        const task = selectedTasks.find((t) => t.id === id);
        if (!task) continue;
        if (mins === (task.estimated_minutes ?? 0)) continue;
        const result = await patchTask(id, { estimated_minutes: mins }, "Update estimate");
        if (result === null) {
          setError("The daily plan could not be saved.");
          return;
        }
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The daily plan could not be saved.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [estimates, onClose, patchTask, selectedTasks]);

  if (!open) return null;

  const currentStep = STEPS[step]!;
  const Icon = currentStep.icon;
  const isLast = step === STEPS.length - 1;

  const renderStepContent = () => {
    if (loading) {
      return <p className="py-6 text-center text-sm text-on-surface-muted">Loading plan…</p>;
    }
    if (loadError) {
      return (
        <div className="space-y-3 py-4 text-center">
          <p role="alert" className="text-sm text-error">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg bg-accent-action px-4 py-2 text-sm text-on-accent-action"
          >
            Retry
          </button>
        </div>
      );
    }

    switch (step) {
      case 0:
        return (
          <div className="max-h-[min(16rem,40dvh)] space-y-2 overflow-y-auto overscroll-contain">
            {overdueTasks.length === 0 ? (
              <p className="py-4 text-center text-sm text-on-surface-muted">
                No overdue tasks. You're all caught up!
              </p>
            ) : (
              <>
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void handleAllToToday()}
                    className="min-h-6 rounded bg-accent-action/10 px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-action/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    All to Today
                  </button>
                </div>
                {overdueTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex flex-col items-stretch gap-2 rounded-lg bg-surface-secondary p-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-on-surface [overflow-wrap:anywhere]">
                        {task.title}
                      </p>
                      {projectName(task.project_id) && (
                        <p className="break-words text-xs text-on-surface-muted [overflow-wrap:anywhere]">
                          {projectName(task.project_id)}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void handleReschedule(task.id)}
                        className="min-h-6 break-words rounded bg-accent-action/10 px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-action/20 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        Reschedule to today
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          /* leave as-is */
                        }}
                        className="min-h-6 rounded px-2 py-1 text-xs text-on-surface-muted transition-colors hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        Skip
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        );

      case 1:
        return (
          <div className="max-h-[min(16rem,40dvh)] space-y-2 overflow-y-auto overscroll-contain">
            <p className="text-xs text-on-surface-muted">
              Choose up to {MAX_FOCUS} focus tasks. Set Aside hides a candidate for this session.
            </p>
            {focusCandidates.length === 0 ? (
              <p className="py-4 text-center text-sm text-on-surface-muted">
                No tasks scheduled for today yet.
              </p>
            ) : (
              focusCandidates.map((task) => {
                const selected = selectedIds.has(task.id);
                return (
                  <div
                    key={task.id}
                    className={`flex items-center gap-3 rounded-lg p-2 transition-colors ${
                      selected ? "bg-surface-secondary" : "bg-surface-secondary/50 opacity-70"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={pending}
                      onChange={() => handleToggleSelect(task.id)}
                      aria-label={`Select ${task.title} as focus`}
                      className="rounded border-border text-accent-foreground focus:ring-focus"
                    />
                    <span className="min-w-0 flex-1 break-words text-sm text-on-surface [overflow-wrap:anywhere]">
                      {task.title}
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => handleSetAside(task.id)}
                      className="shrink-0 rounded px-2 py-1 text-xs text-on-surface-muted transition-colors hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      Set Aside
                    </button>
                  </div>
                );
              })
            )}
          </div>
        );

      case 2: {
        const over = totalPlanned > capacityMinutes;
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-on-surface-muted">Total planned</span>
              <span
                className={over ? "font-medium text-error" : "font-medium text-accent-foreground"}
              >
                {formatDurationMinutes(totalPlanned)} / {formatDurationMinutes(capacityMinutes)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-tertiary">
              <div
                className={`h-full rounded-full transition-[width,background-color] ${over ? "bg-error" : "bg-accent-action"}`}
                style={{
                  width: `${Math.min((totalPlanned / Math.max(capacityMinutes, 1)) * 100, 100)}%`,
                }}
              />
            </div>
            <div className="max-h-[min(12rem,40dvh)] space-y-2 overflow-y-auto overscroll-contain">
              {selectedTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-secondary p-2"
                >
                  <span className="min-w-0 flex-1 break-words text-sm text-on-surface [overflow-wrap:anywhere]">
                    {task.title}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      name={`estimated-minutes-${task.id}`}
                      autoComplete="off"
                      aria-label={`Estimated minutes for ${task.title}`}
                      disabled={pending}
                      value={estimates.get(task.id) ?? task.estimated_minutes ?? 0}
                      onChange={(e) =>
                        setEstimates((prev) => {
                          const next = new Map(prev);
                          next.set(task.id, Math.max(0, Number.parseInt(e.target.value, 10) || 0));
                          return next;
                        })
                      }
                      className="w-16 rounded border border-border bg-surface px-1 py-1 text-center text-xs focus:outline-none focus:ring-1 focus:ring-focus"
                    />
                    <span className="text-xs text-on-surface-muted">min</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      }

      case 3:
        return (
          <div className="break-words py-4 text-center [overflow-wrap:anywhere]">
            <p className="text-lg font-semibold text-on-surface">
              {selectedTasks.length} {selectedTasks.length === 1 ? "task" : "tasks"}
            </p>
            {totalPlanned > 0 && (
              <p className="mt-1 text-sm text-on-surface-muted">
                ~{formatDurationMinutes(totalPlanned)} estimated
              </p>
            )}
            <p className="mt-3 text-sm text-on-surface-muted">Let's make today count.</p>
          </div>
        );

      default:
        return null;
    }
  };

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto overscroll-contain bg-black/40 p-2 backdrop-blur-sm sm:p-4"
      onClick={(event) => {
        if (event.target === overlayRef.current) requestDismiss();
      }}
      data-testid="daily-planning-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-planning-title"
        aria-busy={pending || loading || undefined}
        className="max-h-[calc(100dvh-1rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-3 shadow-2xl animate-scale-fade-in sm:p-6"
      >
        <div aria-hidden="true" className="mb-3 flex justify-center gap-2 sm:mb-6">
          {STEPS.map((_, index) => (
            <span
              key={index}
              className={`h-1.5 rounded-full transition-[width,background-color] ${
                index === step ? "w-6 bg-accent-action" : "w-1.5 bg-surface-tertiary"
              }`}
            />
          ))}
        </div>

        <div className="mb-3 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-action/10">
            <Icon aria-hidden="true" size={24} className="text-accent-foreground" />
          </div>
        </div>
        <h2
          id="daily-planning-title"
          className="mb-4 break-words text-center text-lg font-semibold text-balance text-on-surface [overflow-wrap:anywhere]"
        >
          {currentStep.title}
        </h2>

        {renderStepContent()}

        {error && (
          <p role="alert" className="mt-4 break-words text-sm text-error [overflow-wrap:anywhere]">
            {error}
          </p>
        )}

        {pending && (
          <span role="status" aria-live="polite" className="sr-only">
            Saving daily plan changes…
          </span>
        )}

        <div className="mt-4 flex flex-wrap justify-between gap-2 sm:mt-6">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((current) => current - 1)}
              disabled={pending}
              className="min-h-[44px] rounded px-4 py-2.5 text-sm text-on-surface-muted transition-colors hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={requestDismiss}
              disabled={pending}
              className="min-h-[44px] rounded px-4 py-2.5 text-sm text-on-surface-muted transition-colors hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Skip
            </button>
          )}
          <button
            type="button"
            data-autofocus
            onClick={() => {
              if (isLast) void handleFinish();
              else setStep((current) => current + 1);
            }}
            disabled={pending || loading}
            className="min-h-[44px] rounded-lg bg-accent-action px-5 py-2.5 text-sm font-medium text-on-accent-action transition-colors hover:bg-accent-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {isLast ? "Start My Day" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
