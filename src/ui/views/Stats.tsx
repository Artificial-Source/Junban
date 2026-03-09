import { useMemo } from "react";
import { BarChart3, Flame, Calendar, Clock, Target } from "lucide-react";
import { toDateKey } from "../../utils/format-date.js";
import type { Task } from "../../core/types.js";

interface StatsProps {
  tasks: Task[];
}

/** Format minutes as "30m", "1h", "1.5h", etc. */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** Get the Monday-based start of the current week as a date key (YYYY-MM-DD). */
function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return toDateKey(monday);
}

/** Get last 7 days as an array of { key: "YYYY-MM-DD", label: "Mon" } */
function getLast7Days(): { key: string; label: string }[] {
  const days: { key: string; label: string }[] = [];
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ key: toDateKey(d), label: labels[d.getDay()] });
  }
  return days;
}

/** Count consecutive days backwards from today that have at least 1 completion. */
function computeStreak(completedDates: Set<string>): number {
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = toDateKey(d);
    if (completedDates.has(key)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

export function Stats({ tasks }: StatsProps) {
  const today = toDateKey(new Date());
  const weekStart = getWeekStart();
  const last7Days = getLast7Days();

  const completedTasks = useMemo(() => tasks.filter((t) => t.status === "completed"), [tasks]);

  const totalCompleted = completedTasks.length;

  const completedToday = useMemo(
    () => completedTasks.filter((t) => t.completedAt?.startsWith(today)).length,
    [completedTasks, today],
  );

  const completedThisWeek = useMemo(
    () =>
      completedTasks.filter((t) => {
        const day = t.completedAt?.split("T")[0];
        return day && day >= weekStart;
      }).length,
    [completedTasks, weekStart],
  );

  const streak = useMemo(() => {
    const dates = new Set<string>();
    for (const t of completedTasks) {
      if (t.completedAt) dates.add(t.completedAt.split("T")[0]);
    }
    return computeStreak(dates);
  }, [completedTasks]);

  const totalEstimatedMinutes = useMemo(
    () => completedTasks.reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0),
    [completedTasks],
  );

  /** Completions per day for last 7 days */
  const dailyCounts = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const t of completedTasks) {
      if (t.completedAt) {
        const day = t.completedAt.split("T")[0];
        countMap.set(day, (countMap.get(day) ?? 0) + 1);
      }
    }
    return last7Days.map((d) => ({
      ...d,
      count: countMap.get(d.key) ?? 0,
    }));
  }, [completedTasks, last7Days]);

  const maxCount = Math.max(...dailyCounts.map((d) => d.count), 1);

  // Estimation accuracy stats
  const accuracyStats = useMemo(() => {
    const tracked = completedTasks.filter(
      (t) =>
        t.estimatedMinutes != null &&
        t.estimatedMinutes > 0 &&
        t.actualMinutes != null &&
        t.actualMinutes > 0,
    );
    if (tracked.length === 0) return null;

    let totalVariance = 0;
    for (const t of tracked) {
      totalVariance += Math.abs(t.actualMinutes! - t.estimatedMinutes!) / t.estimatedMinutes!;
    }
    const avgVariance = totalVariance / tracked.length;
    const accuracy = Math.max(0, Math.round((1 - avgVariance) * 100));
    const avgEstimated = tracked.reduce((s, t) => s + t.estimatedMinutes!, 0) / tracked.length;
    const avgActual = tracked.reduce((s, t) => s + t.actualMinutes!, 0) / tracked.length;

    return {
      accuracy,
      avgVariance: Math.round(avgVariance * 100),
      count: tracked.length,
      avgEstimated: Math.round(avgEstimated),
      avgActual: Math.round(avgActual),
    };
  }, [completedTasks]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <BarChart3 size={24} className="text-accent" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Productivity</h1>
      </div>

      {/* Stats cards grid */}
      <div className="grid grid-cols-2 gap-3 mb-8">
        {/* Completed Today */}
        <div className="rounded-xl border border-border bg-surface-secondary p-4">
          <div className="flex items-center gap-2 mb-2">
            <Calendar size={14} className="text-on-surface-muted" />
            <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
              Today
            </span>
          </div>
          <p className="text-2xl font-bold text-on-surface">{completedToday}</p>
          <p className="text-xs text-on-surface-muted mt-0.5">
            {completedToday === 1 ? "task" : "tasks"} completed
          </p>
        </div>

        {/* This Week */}
        <div className="rounded-xl border border-border bg-surface-secondary p-4">
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 size={14} className="text-on-surface-muted" />
            <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
              This Week
            </span>
          </div>
          <p className="text-2xl font-bold text-on-surface">{completedThisWeek}</p>
          <p className="text-xs text-on-surface-muted mt-0.5">
            {completedThisWeek === 1 ? "task" : "tasks"} completed
          </p>
        </div>

        {/* Current Streak */}
        <div className="rounded-xl border border-border bg-surface-secondary p-4">
          <div className="flex items-center gap-2 mb-2">
            <Flame size={14} className="text-on-surface-muted" />
            <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
              Streak
            </span>
          </div>
          <p className="text-2xl font-bold text-on-surface">{streak}</p>
          <p className="text-xs text-on-surface-muted mt-0.5">
            consecutive {streak === 1 ? "day" : "days"}
          </p>
        </div>

        {/* Time Tracked */}
        <div className="rounded-xl border border-border bg-surface-secondary p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock size={14} className="text-on-surface-muted" />
            <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
              Time Tracked
            </span>
          </div>
          <p className="text-2xl font-bold text-on-surface">
            {totalEstimatedMinutes > 0 ? formatMinutes(totalEstimatedMinutes) : "0m"}
          </p>
          <p className="text-xs text-on-surface-muted mt-0.5">
            from {totalCompleted} completed {totalCompleted === 1 ? "task" : "tasks"}
          </p>
        </div>
      </div>

      {/* Bar chart: Last 7 days */}
      <div>
        <h2 className="text-sm font-semibold text-on-surface mb-3">Last 7 Days</h2>
        <div className="flex items-end justify-between gap-2 h-[152px] px-1">
          {dailyCounts.map((day) => (
            <div key={day.key} className="flex-1 flex flex-col items-center gap-1">
              {/* Count label */}
              <span className="text-xs text-on-surface-muted font-mono">
                {day.count > 0 ? day.count : ""}
              </span>
              {/* Bar */}
              <div className="w-full flex justify-center" style={{ height: 120 }}>
                <div
                  className="w-full max-w-[40px] rounded-t-md bg-accent transition-all duration-300"
                  style={{
                    height: day.count > 0 ? (day.count / maxCount) * 120 : 2,
                    opacity: day.count > 0 ? 1 : 0.2,
                    alignSelf: "flex-end",
                  }}
                />
              </div>
              {/* Day label */}
              <span
                className={`text-xs ${
                  day.key === today ? "text-accent font-semibold" : "text-on-surface-muted"
                }`}
              >
                {day.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Estimation Accuracy */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-on-surface mb-3 flex items-center gap-2">
          <Target size={14} />
          Estimation Accuracy
        </h2>
        {accuracyStats ? (
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-border bg-surface-secondary p-3 text-center">
              <p className="text-xl font-bold text-on-surface">{accuracyStats.accuracy}%</p>
              <p className="text-xs text-on-surface-muted">Accuracy</p>
            </div>
            <div className="rounded-xl border border-border bg-surface-secondary p-3 text-center">
              <p className="text-xl font-bold text-on-surface">
                {formatMinutes(accuracyStats.avgEstimated)} →{" "}
                {formatMinutes(accuracyStats.avgActual)}
              </p>
              <p className="text-xs text-on-surface-muted">Avg est. → actual</p>
            </div>
            <div className="rounded-xl border border-border bg-surface-secondary p-3 text-center">
              <p className="text-xl font-bold text-on-surface">{accuracyStats.count}</p>
              <p className="text-xs text-on-surface-muted">Tasks tracked</p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-on-surface-muted italic">
            Complete tasks with both estimated and actual times to see accuracy stats.
          </p>
        )}
      </div>
    </div>
  );
}
