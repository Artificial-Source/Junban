/**
 * Weekly Review modal over Rust `/planning/weekly` facts for the prior complete week.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  CheckCircle2,
  PlusCircle,
  AlertTriangle,
  Flame,
  Trophy,
  FolderX,
  Lightbulb,
} from "lucide-react";
import { ApiError, getWeeklyReview, type TaskDto, type WeeklyReviewResponse } from "../api/client";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useWorkspace } from "../context/WorkspaceContext";
import {
  civilDayName,
  completionBucketLabel,
  formatWeekRange,
  neglectedReasonLabel,
  weeklySuggestionText,
} from "../lib/planningLabels";

const PRIORITY_COLORS: Record<number, string> = {
  1: "bg-error/15 text-error",
  2: "bg-warning/15 text-warning",
  3: "bg-info/15 text-info",
  4: "bg-on-surface-muted/15 text-on-surface-muted",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

interface WeeklyReviewModalProps {
  open: boolean;
  onClose: () => void;
}

export function WeeklyReviewModal({ open, onClose }: WeeklyReviewModalProps) {
  const { catalog } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<WeeklyReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusTrap(containerRef, open);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getWeeklyReview());
    } catch (caught) {
      setData(null);
      setError(caught instanceof ApiError ? caught.message : "Could not load the weekly review.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const projectName = (id: string) => catalog?.projects.find((p) => p.id === id)?.name ?? "Project";

  const maxCompleted = Math.max(...(data?.daily.map((d) => d.completed) ?? [0]), 1);

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      data-testid="weekly-review-backdrop"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="weekly-review-title"
        className="mx-3 flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-2xl animate-scale-fade-in sm:mx-auto"
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
          <div>
            <h2 id="weekly-review-title" className="text-lg font-semibold text-on-surface">
              Weekly Review
            </h2>
            {data && (
              <p className="text-xs text-on-surface-muted">
                {formatWeekRange(data.week_start, data.week_end)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2.5 text-on-surface-muted transition-colors hover:bg-surface-secondary sm:p-1.5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto px-4 pb-4 sm:px-6 sm:pb-6">
          {loading && (
            <p className="py-8 text-center text-sm text-on-surface-muted">Loading weekly review…</p>
          )}
          {error && (
            <div className="space-y-3 py-4 text-center">
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-lg bg-accent-action px-4 py-2 text-sm text-on-accent-action"
              >
                Retry
              </button>
            </div>
          )}
          {data && !loading && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="summary-stats">
                <StatCard
                  icon={<CheckCircle2 size={16} className="text-success" />}
                  label="Completed"
                  value={data.completed_count}
                />
                <StatCard
                  icon={<PlusCircle size={16} className="text-accent-foreground" />}
                  label="Created"
                  value={data.created_count}
                />
                <StatCard
                  icon={<AlertTriangle size={16} className="text-error" />}
                  label="Overdue"
                  value={data.overdue_tasks.length}
                />
                <StatCard
                  icon={<Flame size={16} className="text-warning" />}
                  label="Streak"
                  value={`${data.streak_days}d`}
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-on-surface-muted">Completion Rate</span>
                  <span className="font-semibold text-on-surface">
                    {data.completion_rate_percent}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-tertiary">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      data.completion_rate_percent >= 70
                        ? "bg-success"
                        : data.completion_rate_percent >= 40
                          ? "bg-warning"
                          : "bg-error"
                    }`}
                    style={{ width: `${data.completion_rate_percent}%` }}
                  />
                </div>
              </div>

              <div data-testid="daily-chart">
                <h3 className="mb-3 text-sm font-medium text-on-surface">Daily Completions</h3>
                <div className="flex h-32 items-end gap-2">
                  {data.daily.map((day) => {
                    const heightPct = maxCompleted > 0 ? (day.completed / maxCompleted) * 100 : 0;
                    const name = civilDayName(day.date);
                    return (
                      <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
                        <span className="text-[10px] tabular-nums text-on-surface-muted">
                          {day.completed}
                        </span>
                        <div className="flex w-full items-end" style={{ height: "80px" }}>
                          <div
                            className="w-full rounded-t-md bg-accent-action/70 transition-all duration-500"
                            data-testid={`bar-${name}`}
                            style={{
                              height: `${Math.max(heightPct, day.completed > 0 ? 4 : 0)}%`,
                            }}
                          />
                        </div>
                        <span className="text-[10px] text-on-surface-muted">{name}</span>
                      </div>
                    );
                  })}
                </div>
                {data.busiest_day && (
                  <p className="mt-2 text-xs text-on-surface-muted">
                    Busiest day:{" "}
                    <span className="font-medium text-on-surface">
                      {civilDayName(data.busiest_day, true)}
                    </span>
                  </p>
                )}
                {data.dominant_completion_bucket && (
                  <p className="mt-1 text-xs text-on-surface-muted">
                    Most productive:{" "}
                    <span className="font-medium capitalize text-on-surface">
                      {completionBucketLabel(data.dominant_completion_bucket)}
                    </span>
                  </p>
                )}
              </div>

              {data.top_accomplishment_tasks.length > 0 && (
                <Accomplishments tasks={data.top_accomplishment_tasks} />
              )}

              {data.neglected_projects.length > 0 && (
                <div data-testid="neglected-projects">
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-on-surface">
                    <FolderX size={14} className="text-error" />
                    Neglected Projects
                  </h3>
                  <div className="space-y-1">
                    {data.neglected_projects.map((project) => (
                      <div
                        key={project.project_id}
                        className="flex items-center justify-between rounded-lg bg-surface-secondary p-2"
                      >
                        <span className="text-sm text-on-surface">
                          {projectName(project.project_id)}
                        </span>
                        <span className="text-xs text-on-surface-muted">
                          {neglectedReasonLabel(project.reason, project.overdue_count)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.overdue_tasks.length > 0 && (
                <div data-testid="overdue-tasks">
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-error">
                    <AlertTriangle size={14} />
                    {data.overdue_tasks.length} Overdue Task
                    {data.overdue_tasks.length !== 1 ? "s" : ""}
                  </h3>
                  <div className="space-y-1">
                    {data.overdue_tasks.map((task) => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                  </div>
                </div>
              )}

              {data.suggestions.length > 0 && (
                <div
                  className="rounded-xl border border-accent-action/20 bg-accent-action/5 p-4"
                  data-testid="suggestions"
                >
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-on-surface">
                    <Lightbulb size={14} className="text-accent-foreground" />
                    Suggestions for Next Week
                  </h3>
                  <ul className="space-y-1.5">
                    {data.suggestions.map((suggestion, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-on-surface-muted">
                        <span className="mt-0.5 shrink-0 text-accent-foreground">*</span>
                        <span>{weeklySuggestionText(suggestion)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Accomplishments({ tasks }: { tasks: TaskDto[] }) {
  return (
    <div data-testid="accomplishments">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-on-surface">
        <Trophy size={14} className="text-warning" />
        Top Accomplishments
      </h3>
      <div className="space-y-1">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} showCheck />
        ))}
      </div>
    </div>
  );
}

function TaskRow({ task, showCheck = false }: { task: TaskDto; showCheck?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-secondary p-2">
      {showCheck && <CheckCircle2 size={14} className="shrink-0 text-success" />}
      <span className="flex-1 truncate text-sm text-on-surface">{task.title}</span>
      {task.priority != null && task.priority >= 1 && task.priority <= 4 && (
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${PRIORITY_COLORS[task.priority]}`}
        >
          {PRIORITY_LABELS[task.priority]}
        </span>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl bg-surface-secondary p-2.5 sm:p-3">
      {icon}
      <span className="text-xl font-bold tabular-nums text-on-surface">{value}</span>
      <span className="text-[10px] uppercase tracking-wider text-on-surface-muted">{label}</span>
    </div>
  );
}
