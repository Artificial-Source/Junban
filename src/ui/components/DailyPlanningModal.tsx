import { useState, useMemo, useCallback } from "react";
import { AlertTriangle, ListChecks, Clock, Rocket } from "lucide-react";
import { toDateKey } from "../../utils/format-date.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import type { Task, Project } from "../../core/types.js";

interface DailyPlanningModalProps {
  open: boolean;
  onComplete: () => void;
  tasks: Task[];
  projects: Project[];
  onUpdateTask: (id: string, updates: Record<string, unknown>) => void;
}

const STEPS = [
  { icon: AlertTriangle, title: "Review Overdue" },
  { icon: ListChecks, title: "Today's Focus" },
  { icon: Clock, title: "Time Budget" },
  { icon: Rocket, title: "Ready!" },
];

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function DailyPlanningModal({
  open,
  onComplete,
  tasks,
  projects,
  onUpdateTask,
}: DailyPlanningModalProps) {
  const { settings } = useGeneralSettings();
  const [step, setStep] = useState(0);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [estimates, setEstimates] = useState<Map<string, number>>(new Map());

  const today = toDateKey(new Date());

  const overdueTasks = useMemo(
    () =>
      tasks.filter((t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < today),
    [tasks, today],
  );

  const todayTasks = useMemo(
    () => tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today)),
    [tasks, today],
  );

  const selectedTodayTasks = useMemo(
    () => todayTasks.filter((t) => !excludedIds.has(t.id)),
    [todayTasks, excludedIds],
  );

  const capacityMinutes = parseInt(settings.daily_capacity_minutes, 10) || 480;

  const totalPlanned = useMemo(() => {
    return selectedTodayTasks.reduce(
      (sum, t) => sum + (estimates.get(t.id) ?? t.estimatedMinutes ?? 0),
      0,
    );
  }, [selectedTodayTasks, estimates]);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const handleReschedule = useCallback(
    (id: string) => {
      onUpdateTask(id, { dueDate: today });
    },
    [onUpdateTask, today],
  );

  const handleToggleExclude = useCallback((id: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleEstimateChange = useCallback((id: string, value: number) => {
    setEstimates((prev) => {
      const next = new Map(prev);
      next.set(id, value);
      return next;
    });
  }, []);

  const handleFinish = useCallback(() => {
    // Apply any updated estimates
    for (const [id, mins] of estimates) {
      const task = todayTasks.find((t) => t.id === id);
      if (task && mins !== (task.estimatedMinutes ?? 0)) {
        onUpdateTask(id, { estimatedMinutes: mins });
      }
    }
    onComplete();
  }, [estimates, todayTasks, onUpdateTask, onComplete]);

  if (!open) return null;

  const currentStep = STEPS[step];
  const Icon = currentStep.icon;
  const isLast = step === STEPS.length - 1;

  const renderStepContent = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-2 max-h-64 overflow-auto">
            {overdueTasks.length === 0 ? (
              <p className="text-sm text-on-surface-muted text-center py-4">
                No overdue tasks. You're all caught up!
              </p>
            ) : (
              overdueTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface-secondary"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-on-surface truncate">{task.title}</p>
                    {task.projectId && (
                      <p className="text-xs text-on-surface-muted">
                        {projectMap.get(task.projectId)?.name}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleReschedule(task.id)}
                      className="px-2 py-1 text-xs font-medium rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                    >
                      Reschedule to today
                    </button>
                    <button
                      onClick={() => {
                        /* Skip = do nothing, leave as-is */
                      }}
                      className="px-2 py-1 text-xs rounded text-on-surface-muted hover:bg-surface-tertiary transition-colors"
                    >
                      Skip
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        );

      case 1:
        return (
          <div className="space-y-2 max-h-64 overflow-auto">
            {todayTasks.length === 0 ? (
              <p className="text-sm text-on-surface-muted text-center py-4">
                No tasks scheduled for today yet.
              </p>
            ) : (
              todayTasks.map((task) => {
                const excluded = excludedIds.has(task.id);
                return (
                  <label
                    key={task.id}
                    className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                      excluded ? "bg-surface-secondary/50 opacity-60" : "bg-surface-secondary"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={!excluded}
                      onChange={() => handleToggleExclude(task.id)}
                      className="rounded border-border text-accent focus:ring-accent"
                    />
                    <span className="text-sm text-on-surface flex-1 truncate">{task.title}</span>
                  </label>
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
              <span className={over ? "text-error font-medium" : "text-accent font-medium"}>
                {formatDuration(totalPlanned)} / {formatDuration(capacityMinutes)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-surface-tertiary overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${over ? "bg-error" : "bg-accent"}`}
                style={{ width: `${Math.min((totalPlanned / capacityMinutes) * 100, 100)}%` }}
              />
            </div>
            <div className="space-y-2 max-h-48 overflow-auto">
              {selectedTodayTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface-secondary"
                >
                  <span className="text-sm text-on-surface flex-1 truncate">{task.title}</span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <input
                      type="number"
                      min={0}
                      value={estimates.get(task.id) ?? task.estimatedMinutes ?? 0}
                      onChange={(e) =>
                        handleEstimateChange(
                          task.id,
                          Math.max(0, parseInt(e.target.value, 10) || 0),
                        )
                      }
                      className="w-16 text-xs text-center rounded border border-border bg-surface px-1 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
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
          <div className="text-center py-4">
            <p className="text-lg font-semibold text-on-surface">
              {selectedTodayTasks.length} {selectedTodayTasks.length === 1 ? "task" : "tasks"}
            </p>
            {totalPlanned > 0 && (
              <p className="text-sm text-on-surface-muted mt-1">
                ~{formatDuration(totalPlanned)} estimated
              </p>
            )}
            <p className="text-sm text-on-surface-muted mt-3">Let's make today count.</p>
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
            onClick={isLast ? handleFinish : () => setStep((s) => s + 1)}
            className="px-5 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
          >
            {isLast ? "Start My Day" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
