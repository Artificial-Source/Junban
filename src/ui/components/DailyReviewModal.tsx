import { useState, useMemo, useCallback } from "react";
import { Trophy, ArrowRight, CalendarCheck, PartyPopper } from "lucide-react";
import { toDateKey } from "../../utils/format-date.js";
import type { Task } from "../../core/types.js";

interface DailyReviewModalProps {
  open: boolean;
  onComplete: () => void;
  tasks: Task[];
  onUpdateTask: (id: string, updates: Record<string, unknown>) => void;
}

const STEPS = [
  { icon: Trophy, title: "Today's Wins" },
  { icon: ArrowRight, title: "Carried Over" },
  { icon: CalendarCheck, title: "Tomorrow Preview" },
  { icon: PartyPopper, title: "Done!" },
];

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function DailyReviewModal({ open, onComplete, tasks, onUpdateTask }: DailyReviewModalProps) {
  const [step, setStep] = useState(0);

  const today = toDateKey(new Date());

  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return toDateKey(d);
  }, []);

  const completedToday = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status === "completed" &&
          t.completedAt != null &&
          toDateKey(new Date(t.completedAt)) === today,
      ),
    [tasks, today],
  );

  const pendingToday = useMemo(
    () => tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today)),
    [tasks, today],
  );

  const tomorrowTasks = useMemo(
    () => tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(tomorrow)),
    [tasks, tomorrow],
  );

  const tomorrowEstimate = useMemo(
    () => tomorrowTasks.reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0),
    [tomorrowTasks],
  );

  const todayTotal = completedToday.length + pendingToday.length;
  const completionRate =
    todayTotal > 0 ? Math.round((completedToday.length / todayTotal) * 100) : 0;

  const handleMoveToTomorrow = useCallback(
    (id: string) => {
      onUpdateTask(id, { dueDate: tomorrow });
    },
    [onUpdateTask, tomorrow],
  );

  const handleMoveToSomeday = useCallback(
    (id: string) => {
      onUpdateTask(id, { isSomeday: true, dueDate: null });
    },
    [onUpdateTask],
  );

  if (!open) return null;

  const currentStep = STEPS[step];
  const Icon = currentStep.icon;
  const isLast = step === STEPS.length - 1;

  const renderStepContent = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-6 py-2">
              <div className="text-center">
                <p className="text-3xl font-bold text-accent">{completedToday.length}</p>
                <p className="text-xs text-on-surface-muted">completed</p>
              </div>
              {todayTotal > 0 && (
                <div className="text-center">
                  <p className="text-3xl font-bold text-on-surface">{completionRate}%</p>
                  <p className="text-xs text-on-surface-muted">completion rate</p>
                </div>
              )}
            </div>
            {completedToday.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-auto">
                {completedToday.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 p-2 rounded-lg bg-surface-secondary"
                  >
                    <span className="text-accent">✓</span>
                    <span className="text-sm text-on-surface truncate">{task.title}</span>
                  </div>
                ))}
              </div>
            )}
            {completedToday.length === 0 && (
              <p className="text-sm text-on-surface-muted text-center py-2">
                No tasks completed today yet.
              </p>
            )}
          </div>
        );

      case 1:
        return (
          <div className="space-y-2 max-h-64 overflow-auto">
            {pendingToday.length === 0 ? (
              <p className="text-sm text-on-surface-muted text-center py-4">
                All tasks completed! Nothing to carry over.
              </p>
            ) : (
              pendingToday.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface-secondary"
                >
                  <span className="text-sm text-on-surface flex-1 truncate">{task.title}</span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleMoveToTomorrow(task.id)}
                      className="px-2 py-1 text-xs font-medium rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                    >
                      Move to Tomorrow
                    </button>
                    <button
                      onClick={() => handleMoveToSomeday(task.id)}
                      className="px-2 py-1 text-xs rounded text-on-surface-muted hover:bg-surface-tertiary transition-colors"
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
        const heavy = tomorrowTasks.length > 8 || tomorrowEstimate > 480;
        return (
          <div className="space-y-3">
            <div className="text-center py-2">
              <p className="text-2xl font-bold text-on-surface">{tomorrowTasks.length}</p>
              <p className="text-xs text-on-surface-muted">
                {tomorrowTasks.length === 1 ? "task" : "tasks"} tomorrow
              </p>
              {tomorrowEstimate > 0 && (
                <p className="text-sm text-on-surface-muted mt-1">
                  {formatDuration(tomorrowEstimate)} estimated
                </p>
              )}
            </div>
            <div
              className={`text-center text-sm font-medium ${heavy ? "text-warning" : "text-accent"}`}
            >
              {heavy ? "Heavy day ahead — consider trimming" : "Looks manageable"}
            </div>
            {tomorrowTasks.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-auto">
                {tomorrowTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 p-2 rounded-lg bg-surface-secondary"
                  >
                    <span className="text-sm text-on-surface truncate">{task.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }

      case 3:
        return (
          <div className="text-center py-4">
            {completedToday.length > 0 && (
              <p className="text-lg font-semibold text-on-surface mb-2">Great work today!</p>
            )}
            <p className="text-sm text-on-surface-muted">
              {completedToday.length} {completedToday.length === 1 ? "task" : "tasks"} completed
              {todayTotal > 0 ? ` (${completionRate}% completion rate)` : ""}
            </p>
            <p className="text-sm text-on-surface-muted mt-3">
              Rest up and come back strong tomorrow.
            </p>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in p-6">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-6">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-accent" : "w-1.5 bg-surface-tertiary"
              }`}
            />
          ))}
        </div>

        {/* Icon + title */}
        <div className="flex justify-center mb-3">
          <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center">
            <Icon size={24} className="text-accent" />
          </div>
        </div>
        <h2 className="text-lg font-semibold text-on-surface text-center mb-4">
          {currentStep.title}
        </h2>

        {/* Step content */}
        {renderStepContent()}

        {/* Actions */}
        <div className="flex justify-between mt-6">
          {step > 0 ? (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors"
            >
              Back
            </button>
          ) : (
            <button
              onClick={onComplete}
              className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors"
            >
              Skip
            </button>
          )}
          <button
            onClick={isLast ? onComplete : () => setStep((s) => s + 1)}
            className="px-5 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
          >
            {isLast ? "End My Day" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
