import { CheckCircle2, AlertTriangle, ArrowRight, Flame } from "lucide-react";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../ChatTaskResults";

export function DailyReviewCard({ data }: { data: Record<string, unknown> }) {
  const stats = (data.stats ?? {}) as {
    completedCount?: number;
    plannedCount?: number;
    completionRate?: number;
    createdCount?: number;
    netProgress?: number;
  };
  const streak = (data.streak ?? {}) as {
    currentDays?: number;
    isActive?: boolean;
  };
  const completedTasks = (data.completed ?? []) as { title?: string; priority?: number }[];
  const carriedOver = (data.carriedOver ?? []) as { title?: string; priority?: number }[];
  const tomorrow = (data.tomorrow ?? {}) as {
    taskCount?: number;
    tasks?: { title?: string; priority?: number }[];
    assessment?: string;
  };
  const suggestions = (data.suggestions ?? []) as string[];

  const completionRate = stats.completionRate ?? 0;
  const rateColor =
    completionRate >= 80 ? "text-success" : completionRate >= 50 ? "text-warning" : "text-error";
  const rateBarColor =
    completionRate >= 80 ? "bg-success/60" : completionRate >= 50 ? "bg-warning/60" : "bg-error/60";

  return (
    <div className="space-y-3">
      {/* Stats summary row */}
      <div className="flex items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={12} className="text-success" />
          <span className="font-semibold text-on-surface">{stats.completedCount ?? 0}</span>
          <span className="text-on-surface-muted">done</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ArrowRight size={12} className="text-warning" />
          <span className="font-semibold text-on-surface">{carriedOver.length}</span>
          <span className="text-on-surface-muted">carried</span>
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

      {/* Completed task list */}
      {completedTasks.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider mb-1.5">
            Completed
          </p>
          <div className="space-y-0.5">
            {completedTasks.slice(0, 5).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded-md">
                <CheckCircle2 size={12} className="text-success shrink-0" />
                <span className="flex-1 truncate text-on-surface line-through opacity-70">
                  {t.title}
                </span>
              </div>
            ))}
            {completedTasks.length > 5 && (
              <p className="text-[10px] text-on-surface-muted px-2">
                +{completedTasks.length - 5} more
              </p>
            )}
          </div>
        </div>
      )}

      {/* Carried over section */}
      {carriedOver.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider mb-1.5">
            Carried Over
          </p>
          <div className="space-y-0.5">
            {carriedOver.slice(0, 5).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded-md">
                <ArrowRight size={12} className="text-warning shrink-0" />
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

      {/* Tomorrow preview */}
      {tomorrow.taskCount != null && tomorrow.taskCount > 0 && (
        <div>
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider mb-1.5">
            Tomorrow ({tomorrow.taskCount} tasks)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(tomorrow.tasks ?? []).slice(0, 5).map((t, i) => (
              <span
                key={i}
                className="inline-flex px-2.5 py-1 text-xs bg-surface-tertiary text-on-surface-secondary rounded-lg font-medium"
              >
                {t.title}
              </span>
            ))}
          </div>
          {tomorrow.assessment === "heavy" && (
            <p className="text-[10px] text-error mt-1 flex items-center gap-1">
              <AlertTriangle size={10} />
              Heavy day ahead
            </p>
          )}
        </div>
      )}

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border/50">
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
