import { useRef, useEffect, useCallback } from "react";
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
import { useFocusTrap } from "../hooks/useFocusTrap.js";

export interface WeeklyReviewData {
  weekStartDate: string;
  weekEndDate: string;
  completionRate: number;
  taskFlow: {
    created: number;
    completed: number;
    cancelled: number;
    net: number;
  };
  dailyStats: {
    date: string;
    dayName: string;
    completed: number;
    created: number;
  }[];
  busiestDay: {
    date: string;
    dayName: string;
    completed: number;
  } | null;
  productiveTime: string | null;
  productiveTimeCounts: Record<string, number>;
  neglectedProjects: {
    id: string;
    name: string;
    overdueCount: number;
    reason: string;
  }[];
  overdue: {
    count: number;
    tasks: {
      id: string;
      title: string;
      priority: number | null;
      dueDate: string | null;
    }[];
  };
  streak: {
    currentDays: number;
    isActive: boolean;
  };
  topAccomplishments: {
    id: string;
    title: string;
    priority: number | null;
    completedAt: string | null;
    projectId: string | null;
  }[];
  suggestions: string[];
}

interface WeeklyReviewModalProps {
  open: boolean;
  onClose: () => void;
  data: WeeklyReviewData | null;
}

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

function formatDateRange(start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  const sMonth = s.toLocaleDateString(undefined, { month: "short" });
  const eMonth = e.toLocaleDateString(undefined, { month: "short" });
  const sDay = s.getDate();
  const eDay = e.getDate();
  if (sMonth === eMonth) {
    return `${sMonth} ${sDay} - ${eDay}`;
  }
  return `${sMonth} ${sDay} - ${eMonth} ${eDay}`;
}

export function WeeklyReviewModal({ open, onClose, data }: WeeklyReviewModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open || !data) return null;

  const maxCompleted = Math.max(...data.dailyStats.map((d) => d.completed), 1);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={handleBackdropClick}
      data-testid="weekly-review-backdrop"
    >
      <div
        ref={containerRef}
        className="w-full max-w-2xl mx-4 max-h-[90vh] bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div>
            <h2 className="text-lg font-semibold text-on-surface">Weekly Review</h2>
            <p className="text-xs text-on-surface-muted">
              {formatDateRange(data.weekStartDate, data.weekEndDate)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-on-surface-muted hover:bg-surface-secondary transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-auto px-6 pb-6 space-y-5">
          {/* Summary stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="summary-stats">
            <StatCard
              icon={<CheckCircle2 size={16} className="text-success" />}
              label="Completed"
              value={data.taskFlow.completed}
            />
            <StatCard
              icon={<PlusCircle size={16} className="text-accent" />}
              label="Created"
              value={data.taskFlow.created}
            />
            <StatCard
              icon={<AlertTriangle size={16} className="text-error" />}
              label="Overdue"
              value={data.overdue.count}
            />
            <StatCard
              icon={<Flame size={16} className="text-warning" />}
              label="Streak"
              value={`${data.streak.currentDays}d`}
            />
          </div>

          {/* Completion rate bar */}
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-on-surface-muted">Completion Rate</span>
              <span className="font-semibold text-on-surface">{data.completionRate}%</span>
            </div>
            <div className="h-2 rounded-full bg-surface-tertiary overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  data.completionRate >= 70
                    ? "bg-success"
                    : data.completionRate >= 40
                      ? "bg-warning"
                      : "bg-error"
                }`}
                style={{ width: `${data.completionRate}%` }}
              />
            </div>
          </div>

          {/* Bar chart - daily completions */}
          <div data-testid="daily-chart">
            <h3 className="text-sm font-medium text-on-surface mb-3">Daily Completions</h3>
            <div className="flex items-end gap-2 h-32">
              {data.dailyStats.map((day) => {
                const heightPct = maxCompleted > 0 ? (day.completed / maxCompleted) * 100 : 0;
                return (
                  <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                    <span className="text-[10px] text-on-surface-muted tabular-nums">
                      {day.completed}
                    </span>
                    <div className="w-full flex items-end" style={{ height: "80px" }}>
                      <div
                        className="w-full rounded-t-md bg-accent/70 transition-all duration-500"
                        data-testid={`bar-${day.dayName}`}
                        style={{ height: `${Math.max(heightPct, day.completed > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-on-surface-muted">
                      {day.dayName.slice(0, 3)}
                    </span>
                  </div>
                );
              })}
            </div>
            {data.busiestDay && data.busiestDay.completed > 0 && (
              <p className="text-xs text-on-surface-muted mt-2">
                Busiest day:{" "}
                <span className="font-medium text-on-surface">{data.busiestDay.dayName}</span> (
                {data.busiestDay.completed} tasks)
              </p>
            )}
            {data.productiveTime && (
              <p className="text-xs text-on-surface-muted mt-1">
                Most productive:{" "}
                <span className="font-medium text-on-surface capitalize">
                  {data.productiveTime}
                </span>
              </p>
            )}
          </div>

          {/* Top accomplishments */}
          {data.topAccomplishments.length > 0 && (
            <div data-testid="accomplishments">
              <h3 className="text-sm font-medium text-on-surface mb-2 flex items-center gap-1.5">
                <Trophy size={14} className="text-warning" />
                Top Accomplishments
              </h3>
              <div className="space-y-1">
                {data.topAccomplishments.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 p-2 rounded-lg bg-surface-secondary"
                  >
                    <CheckCircle2 size={14} className="text-success shrink-0" />
                    <span className="text-sm text-on-surface flex-1 truncate">{task.title}</span>
                    {task.priority != null && task.priority >= 1 && task.priority <= 4 && (
                      <span
                        className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[task.priority]}`}
                      >
                        {PRIORITY_LABELS[task.priority]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Neglected projects */}
          {data.neglectedProjects.length > 0 && (
            <div data-testid="neglected-projects">
              <h3 className="text-sm font-medium text-on-surface mb-2 flex items-center gap-1.5">
                <FolderX size={14} className="text-error" />
                Neglected Projects
              </h3>
              <div className="space-y-1">
                {data.neglectedProjects.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between p-2 rounded-lg bg-surface-secondary"
                  >
                    <span className="text-sm text-on-surface">{project.name}</span>
                    <span className="text-xs text-on-surface-muted">{project.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Overdue tasks */}
          {data.overdue.count > 0 && (
            <div data-testid="overdue-tasks">
              <h3 className="text-sm font-medium text-error mb-2 flex items-center gap-1.5">
                <AlertTriangle size={14} />
                {data.overdue.count} Overdue Task{data.overdue.count !== 1 ? "s" : ""}
              </h3>
              <div className="space-y-1">
                {data.overdue.tasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 p-2 rounded-lg bg-surface-secondary"
                  >
                    <span className="text-sm text-on-surface flex-1 truncate">{task.title}</span>
                    {task.priority != null && task.priority >= 1 && task.priority <= 4 && (
                      <span
                        className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[task.priority]}`}
                      >
                        {PRIORITY_LABELS[task.priority]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Suggestions */}
          {data.suggestions.length > 0 && (
            <div
              className="rounded-xl bg-accent/5 border border-accent/20 p-4"
              data-testid="suggestions"
            >
              <h3 className="text-sm font-medium text-on-surface mb-2 flex items-center gap-1.5">
                <Lightbulb size={14} className="text-accent" />
                Suggestions for Next Week
              </h3>
              <ul className="space-y-1.5">
                {data.suggestions.map((suggestion, i) => (
                  <li key={i} className="text-xs text-on-surface-muted flex items-start gap-2">
                    <span className="text-accent mt-0.5 shrink-0">*</span>
                    <span>{suggestion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
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
    <div className="flex flex-col items-center gap-1 p-3 rounded-xl bg-surface-secondary">
      {icon}
      <span className="text-xl font-bold text-on-surface tabular-nums">{value}</span>
      <span className="text-[10px] text-on-surface-muted uppercase tracking-wider">{label}</span>
    </div>
  );
}
