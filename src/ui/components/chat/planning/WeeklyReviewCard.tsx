import {
  CheckCircle2,
  AlertTriangle,
  Flame,
  Trophy,
  Lightbulb,
  FolderX,
} from "lucide-react";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../ChatTaskResults";

export function WeeklyReviewCard({ data }: { data: Record<string, unknown> }) {
  const taskFlow = (data.taskFlow ?? {}) as {
    created?: number;
    completed?: number;
    cancelled?: number;
  };
  const completionRate = (data.completionRate as number) ?? 0;
  const streak = (data.streak ?? {}) as { currentDays?: number; isActive?: boolean };
  const overdue = (data.overdue ?? {}) as { count?: number };
  const topAccomplishments = (data.topAccomplishments ?? []) as {
    title?: string;
    priority?: number;
  }[];
  const neglectedProjects = (data.neglectedProjects ?? []) as {
    name?: string;
    reason?: string;
  }[];
  const suggestions = (data.suggestions ?? []) as string[];
  const dailyStats = (data.dailyStats ?? []) as {
    dayName?: string;
    completed?: number;
  }[];
  const busiestDay = data.busiestDay as { dayName?: string; completed?: number } | null;
  const productiveTime = data.productiveTime as string | null;

  const rateColor =
    completionRate >= 70 ? "text-success" : completionRate >= 40 ? "text-warning" : "text-error";
  const rateBarColor =
    completionRate >= 70 ? "bg-success/60" : completionRate >= 40 ? "bg-warning/60" : "bg-error/60";

  const maxCompleted = Math.max(...dailyStats.map((d) => d.completed ?? 0), 1);

  return (
    <div className="space-y-3">
      {/* Stats summary row */}
      <div className="flex items-center gap-3 text-xs flex-wrap">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={12} className="text-success" />
          <span className="font-semibold text-on-surface">{taskFlow.completed ?? 0}</span>
          <span className="text-on-surface-muted">done</span>
        </div>
        <div className="flex items-center gap-1.5">
          <AlertTriangle size={12} className="text-error" />
          <span className="font-semibold text-on-surface">{overdue.count ?? 0}</span>
          <span className="text-on-surface-muted">overdue</span>
        </div>
        {streak.isActive && streak.currentDays && streak.currentDays > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            <Flame size={12} className="text-error" />
            <span className="font-semibold text-on-surface tabular-nums">{streak.currentDays}</span>
            <span className="text-on-surface-muted">day streak</span>
          </div>
        )}
      </div>

      {/* Completion rate bar */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-on-surface-muted w-10 shrink-0">Rate</span>
        <div className="flex-1 h-2.5 bg-surface-tertiary rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${rateBarColor}`}
            style={{ width: `${completionRate}%` }}
          />
        </div>
        <span className={`w-8 text-right font-semibold tabular-nums ${rateColor}`}>
          {completionRate}%
        </span>
      </div>

      {/* Mini bar chart */}
      {dailyStats.length > 0 && (
        <div className="flex items-end gap-1 h-12">
          {dailyStats.map((day, i) => {
            const heightPct = maxCompleted > 0 ? ((day.completed ?? 0) / maxCompleted) * 100 : 0;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                <div className="w-full flex items-end" style={{ height: "32px" }}>
                  <div
                    className="w-full rounded-t-sm bg-accent/60"
                    style={{
                      height: `${Math.max(heightPct, (day.completed ?? 0) > 0 ? 4 : 0)}%`,
                    }}
                  />
                </div>
                <span className="text-[8px] text-on-surface-muted">
                  {(day.dayName ?? "").slice(0, 2)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Busiest day + productive time */}
      {(busiestDay || productiveTime) && (
        <div className="flex gap-3 text-[10px] text-on-surface-muted">
          {busiestDay && (busiestDay.completed ?? 0) > 0 && (
            <span>
              Busiest: <span className="text-on-surface font-medium">{busiestDay.dayName}</span>
            </span>
          )}
          {productiveTime && (
            <span>
              Peak: <span className="text-on-surface font-medium capitalize">{productiveTime}</span>
            </span>
          )}
        </div>
      )}

      {/* Top accomplishments */}
      {topAccomplishments.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <Trophy size={10} className="text-warning" />
            Top Accomplishments
          </p>
          <div className="space-y-0.5">
            {topAccomplishments.slice(0, 3).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded-md">
                <CheckCircle2 size={12} className="text-success shrink-0" />
                <span className="flex-1 truncate text-on-surface">{t.title}</span>
                {t.priority && t.priority >= 1 && t.priority <= 4 && (
                  <span
                    className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[t.priority]}`}
                  >
                    {PRIORITY_LABELS[t.priority]}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Neglected projects */}
      {neglectedProjects.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <FolderX size={10} className="text-error" />
            Neglected Projects
          </p>
          <div className="space-y-0.5">
            {neglectedProjects.slice(0, 3).map((p, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs px-2 py-1 rounded-md"
              >
                <span className="text-on-surface">{p.name}</span>
                <span className="text-[10px] text-on-surface-muted">{p.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border/50">
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1">
            <Lightbulb size={10} className="text-accent" />
            Suggestions
          </p>
          {suggestions.map((s, i) => (
            <p key={i} className="text-[10px] text-on-surface-muted flex items-start gap-1.5">
              <span className="text-accent mt-0.5">*</span>
              {s}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
