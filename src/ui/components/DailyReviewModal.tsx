/**
 * End of Day ritual — full-shell modal over Rust `/planning/end-of-day` facts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trophy, ArrowRight, CalendarCheck, PartyPopper } from "lucide-react";
import { ApiError, getEndOfDayPlan, type EndOfDayResponse } from "../api/client";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { addCivilDays, formatDurationMinutes } from "../lib/planningLabels";

const PENDING_DISMISS_MESSAGE =
  "Save in progress. Wait for it to finish before closing the daily review.";

const STEPS = [
  { icon: Trophy, title: "Today's Wins" },
  { icon: ArrowRight, title: "Carried Over" },
  { icon: CalendarCheck, title: "Tomorrow Preview" },
  { icon: PartyPopper, title: "Done!" },
] as const;

interface DailyReviewModalProps {
  open: boolean;
  onClose: () => void;
}

export function DailyReviewModal({ open, onClose }: DailyReviewModalProps) {
  const { patchTask } = useTaskMutations();
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<EndOfDayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await getEndOfDayPlan();
      setPlan(response);
      setStep(0);
      setError(null);
    } catch (caught) {
      setPlan(null);
      setLoadError(
        caught instanceof ApiError ? caught.message : "Could not load the end-of-day review.",
      );
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

  const updateCarry = useCallback(
    async (taskId: string, body: { due_date: string | null; someday?: boolean }, label: string) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        const result = await patchTask(taskId, body, label);
        if (result === null) {
          setError("The carry-over task could not be updated.");
          return;
        }
        await load();
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "The carry-over task could not be updated.",
        );
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [load, patchTask],
  );

  if (!open) return null;

  const currentStep = STEPS[step]!;
  const Icon = currentStep.icon;
  const isLast = step === STEPS.length - 1;
  const wins = plan?.win_tasks ?? [];
  const carry = plan?.carry_over_tasks ?? [];
  const tomorrowTasks = plan?.tomorrow_tasks ?? [];
  const completionRate = plan?.completion_rate_percent ?? 0;
  const capacity = plan?.capacity_minutes ?? 480;
  const tomorrowEstimate = plan?.tomorrow_estimated_minutes ?? 0;

  const renderStepContent = () => {
    if (loading) {
      return <p className="py-6 text-center text-sm text-on-surface-muted">Loading review…</p>;
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
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 py-2">
              <div className="text-center">
                <p className="text-3xl font-bold text-accent-foreground">{wins.length}</p>
                <p className="text-xs text-on-surface-muted">completed</p>
              </div>
              {(wins.length > 0 || carry.length > 0) && (
                <div className="text-center">
                  <p className="text-3xl font-bold text-on-surface">{completionRate}%</p>
                  <p className="text-xs text-on-surface-muted">completion rate</p>
                </div>
              )}
            </div>
            {wins.length > 0 ? (
              <div className="max-h-[min(12rem,40dvh)] space-y-1 overflow-y-auto overscroll-contain">
                {wins.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 rounded-lg bg-surface-secondary p-2"
                  >
                    <span className="text-accent-foreground" aria-hidden="true">
                      ✓
                    </span>
                    <span className="min-w-0 break-words text-sm text-on-surface [overflow-wrap:anywhere]">
                      {task.title}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-2 text-center text-sm text-on-surface-muted">
                No tasks completed today yet.
              </p>
            )}
          </div>
        );

      case 1:
        return (
          <div className="max-h-[min(16rem,40dvh)] space-y-2 overflow-y-auto overscroll-contain">
            {carry.length === 0 ? (
              <p className="py-4 text-center text-sm text-on-surface-muted">
                All tasks completed! Nothing to carry over.
              </p>
            ) : (
              carry.map((task) => (
                <div
                  key={task.id}
                  className="flex flex-col items-stretch gap-2 rounded-lg bg-surface-secondary p-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0 flex-1 break-words text-sm text-on-surface [overflow-wrap:anywhere]">
                    {task.title}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (!plan) return;
                        void updateCarry(
                          task.id,
                          { due_date: addCivilDays(plan.as_of_date, 1) },
                          "Move to tomorrow",
                        );
                      }}
                      className="min-h-6 break-words rounded bg-accent-action/10 px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-action/20 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      Move to Tomorrow
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void updateCarry(
                          task.id,
                          { due_date: null, someday: true },
                          "Move to Someday",
                        )
                      }
                      className="min-h-6 rounded px-2 py-1 text-xs text-on-surface-muted transition-colors hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      Someday
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        );

      case 2: {
        const heavy = tomorrowTasks.length > 8 || tomorrowEstimate > capacity;
        return (
          <div className="space-y-3">
            <div className="py-2 text-center">
              <p className="text-2xl font-bold text-on-surface">{tomorrowTasks.length}</p>
              <p className="text-xs text-on-surface-muted">
                {tomorrowTasks.length === 1 ? "task" : "tasks"} tomorrow
              </p>
              {tomorrowEstimate > 0 && (
                <p className="mt-1 text-sm text-on-surface-muted">
                  {formatDurationMinutes(tomorrowEstimate)} estimated
                </p>
              )}
            </div>
            <div
              className={`text-center text-sm font-medium ${heavy ? "text-warning" : "text-accent-foreground"}`}
            >
              {heavy ? "Heavy day ahead — consider trimming" : "Looks manageable"}
            </div>
            {tomorrowTasks.length > 0 && (
              <div className="max-h-[min(10rem,40dvh)] space-y-1 overflow-y-auto overscroll-contain">
                {tomorrowTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 rounded-lg bg-surface-secondary p-2"
                  >
                    <span className="break-words text-sm text-on-surface [overflow-wrap:anywhere]">
                      {task.title}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }

      case 3:
        return (
          <div className="break-words py-4 text-center [overflow-wrap:anywhere]">
            {wins.length > 0 && (
              <p className="mb-2 text-lg font-semibold text-on-surface">Great work today!</p>
            )}
            <p className="text-sm text-on-surface-muted">
              {wins.length} {wins.length === 1 ? "task" : "tasks"} completed
              {wins.length + carry.length > 0 ? ` (${completionRate}% completion rate)` : ""}
            </p>
            <p className="mt-3 text-sm text-on-surface-muted">
              Rest up and come back strong tomorrow.
            </p>
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
      data-testid="daily-review-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-review-title"
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
          id="daily-review-title"
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
            Saving daily review changes…
          </span>
        )}

        <div className="mt-4 flex flex-wrap justify-between gap-2 sm:mt-6">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((current) => current - 1)}
              disabled={pending}
              className="min-h-[44px] rounded px-4 py-2 text-sm text-on-surface-muted transition-colors hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={requestDismiss}
              disabled={pending}
              className="min-h-[44px] rounded px-4 py-2 text-sm text-on-surface-muted transition-colors hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Skip
            </button>
          )}
          <button
            type="button"
            data-autofocus
            onClick={isLast ? requestDismiss : () => setStep((current) => current + 1)}
            disabled={pending || loading}
            className="min-h-[44px] rounded-lg bg-accent-action px-5 py-2 text-sm font-medium text-on-accent-action transition-colors hover:bg-accent-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {isLast ? "End My Day" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
