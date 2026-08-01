/**
 * Productivity stats from the Rust `/api/v1/stats` authority only.
 * Period controls request different inclusive civil ranges; no client aggregates.
 */
import { useCallback, useEffect, useState } from "react";
import { BarChart3, Flame, Calendar, Clock, Target } from "lucide-react";
import { ApiError, getStats, type StatsResponse } from "../api/client";
import { useToday } from "../hooks/useToday";
import { ViewSkeleton } from "../components/Skeleton";
import {
  chartRowsWithToday,
  completionsInRange,
  completionsOnDay,
  formatMinutes,
  statsPeriodRange,
  weekStartMonday,
} from "./statsPeriods";

function formatDecimalHours(minutes: number) {
  return `${(minutes / 60).toFixed(1)}h`;
}

export function Stats() {
  const today = useToday();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const range = statsPeriodRange("7d", today);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getStats({ from: range.from, to: range.to });
      setStats(response);
    } catch (caught) {
      setStats(null);
      if (caught instanceof ApiError) setError(caught.message);
      else setError("Could not load statistics.");
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const completedToday = stats ? completionsOnDay(stats.days, today) : 0;
  const weekStart = weekStartMonday(today);
  const completedThisWeek = stats ? completionsInRange(stats.days, weekStart, today) : 0;
  const dailyCounts = stats ? chartRowsWithToday(stats, today) : [];
  const maxCount = Math.max(...dailyCounts.map((d) => d.count), 1);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <BarChart3 size={24} className="text-accent-foreground" />
        <h1 className="text-xl font-bold text-on-surface md:text-2xl">Productivity</h1>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
        >
          {error}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            Retry
          </button>
        </div>
      )}

      {loading && !stats ? (
        <ViewSkeleton />
      ) : stats ? (
        <>
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface-secondary p-4">
              <div className="mb-2 flex items-center gap-2">
                <Calendar size={14} className="text-on-surface-muted" />
                <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                  Today
                </span>
              </div>
              <p className="text-2xl font-bold text-on-surface">{completedToday}</p>
              <p className="mt-0.5 text-xs text-on-surface-muted">
                {completedToday === 1 ? "task" : "tasks"} completed
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-secondary p-4">
              <div className="mb-2 flex items-center gap-2">
                <BarChart3 size={14} className="text-on-surface-muted" />
                <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                  This Week
                </span>
              </div>
              <p className="text-2xl font-bold text-on-surface">{completedThisWeek}</p>
              <p className="mt-0.5 text-xs text-on-surface-muted">
                {completedThisWeek === 1 ? "task" : "tasks"} completed
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-secondary p-4">
              <div className="mb-2 flex items-center gap-2">
                <Flame size={14} className="text-on-surface-muted" />
                <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                  Streak
                </span>
              </div>
              <p className="text-2xl font-bold text-on-surface">{stats.current_streak_days}</p>
              <p className="mt-0.5 text-xs text-on-surface-muted">
                consecutive {stats.current_streak_days === 1 ? "day" : "days"}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-secondary p-4">
              <div className="mb-2 flex items-center gap-2">
                <Clock size={14} className="text-on-surface-muted" />
                <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                  Time Tracked
                </span>
              </div>
              <p className="text-2xl font-bold text-on-surface">
                {stats.total_completion_minutes > 0
                  ? formatMinutes(stats.total_completion_minutes)
                  : "0m"}
              </p>
              <p className="mt-0.5 text-xs text-on-surface-muted">
                from {stats.total_completions} completed{" "}
                {stats.total_completions === 1 ? "task" : "tasks"}
              </p>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-on-surface">Last 7 Days</h2>
            {dailyCounts.length === 0 ? (
              <p className="text-xs italic text-on-surface-muted">No activity in this period.</p>
            ) : (
              <div className="flex h-[140px] items-end justify-between gap-1 px-1 sm:h-[152px] sm:gap-2">
                {dailyCounts.map((day) => (
                  <div key={day.key} className="flex flex-1 flex-col items-center gap-1">
                    <span className="font-mono text-xs text-on-surface-muted">
                      {day.count > 0 ? day.count : ""}
                    </span>
                    <div className="flex w-full justify-center" style={{ height: 120 }}>
                      <div
                        className="w-full max-w-[40px] rounded-t-md bg-accent-action transition-all duration-300"
                        style={{
                          height: day.count > 0 ? (day.count / maxCount) * 120 : 2,
                          opacity: day.count > 0 ? 1 : 0.2,
                          alignSelf: "flex-end",
                        }}
                      />
                    </div>
                    <span
                      className={`text-xs ${
                        day.isToday
                          ? "font-semibold text-accent-foreground"
                          : "text-on-surface-muted"
                      }`}
                    >
                      {day.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-on-surface">
              <Target size={14} />
              Estimation Accuracy
            </h2>
            {stats.estimate_accuracy_samples > 0 && stats.estimate_accuracy_percent != null ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-border bg-surface-secondary p-3 text-center">
                  <p className="text-xl font-bold text-on-surface">
                    {stats.estimate_accuracy_percent}%
                  </p>
                  <p className="text-xs text-on-surface-muted">Accuracy</p>
                </div>
                <div className="rounded-xl border border-border bg-surface-secondary p-3 text-center">
                  <p className="text-xl font-bold text-on-surface">
                    {formatDecimalHours(stats.average_estimated_minutes ?? 0)} →{" "}
                    {formatDecimalHours(stats.average_actual_minutes ?? 0)}
                  </p>
                  <p className="text-xs text-on-surface-muted">Avg est. → actual</p>
                </div>
                <div className="rounded-xl border border-border bg-surface-secondary p-3 text-center">
                  <p className="text-xl font-bold text-on-surface">
                    {stats.estimate_accuracy_samples}
                  </p>
                  <p className="text-xs text-on-surface-muted">Tasks tracked</p>
                </div>
              </div>
            ) : (
              <p className="text-xs italic text-on-surface-muted">
                Complete tasks with both estimated and actual times to see accuracy stats.
              </p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
