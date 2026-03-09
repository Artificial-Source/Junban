import { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Zap,
  Brain,
  Bell,
  ArrowRight,
  Flame,
  ChevronDown,
  ChevronRight,
  Trophy,
  Lightbulb,
  FolderX,
} from "lucide-react";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "./ChatTaskResults";

export interface FocusBlock {
  type: "quick_win" | "deep_work";
  tasks: { id?: string; title?: string; priority?: number }[];
}

export function WorkloadBar({
  assessment,
  total,
  weight,
}: {
  assessment: string;
  total: number;
  weight: number;
}) {
  const color =
    assessment === "heavy"
      ? "bg-error/70"
      : assessment === "normal"
        ? "bg-warning/60"
        : "bg-success/60";
  const label = assessment === "heavy" ? "Heavy" : assessment === "normal" ? "Normal" : "Light";
  const pct = Math.min(100, Math.round((weight / 16) * 100));

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-on-surface-muted w-14 shrink-0">{total} tasks</span>
      <div className="flex-1 h-2.5 bg-surface-tertiary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.max(pct, 6)}%` }}
        />
      </div>
      <span
        className={`text-[10px] font-semibold ${
          assessment === "heavy"
            ? "text-error"
            : assessment === "normal"
              ? "text-warning"
              : "text-success"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

export function DayPlanCard({ data }: { data: Record<string, unknown> }) {
  const workload = (data.workload ?? {}) as {
    totalToday?: number;
    priorityWeight?: number;
    assessment?: string;
    overdueCount?: number;
  };
  const overdueTasks = (data.overdueTasks ?? []) as {
    title?: string;
    daysOverdue?: number;
    priority?: number;
  }[];
  const focusBlocks = (data.focusBlocks ?? {}) as {
    order?: string;
    blocks?: FocusBlock[];
  };
  const remindersToday = (data.remindersToday ?? []) as {
    title?: string;
    remindAt?: string;
  }[];
  const productivityContext = data.productivityContext as {
    insight?: string;
    recentCompletionRate?: number;
  } | null;

  return (
    <div className="space-y-3">
      {/* Workload bar */}
      <WorkloadBar
        assessment={workload.assessment ?? "light"}
        total={workload.totalToday ?? 0}
        weight={workload.priorityWeight ?? 0}
      />

      {/* Overdue section */}
      {overdueTasks.length > 0 && (
        <div>
          <p className="text-xs font-medium text-error flex items-center gap-1.5 mb-1.5">
            <AlertTriangle size={12} />
            {overdueTasks.length} Overdue
          </p>
          <div className="space-y-0.5">
            {overdueTasks.slice(0, 5).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded-md">
                <span className="flex-1 truncate text-on-surface">{t.title}</span>
                {t.daysOverdue && (
                  <span className="shrink-0 text-[10px] text-error font-medium">
                    {t.daysOverdue}d late
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Focus blocks */}
      {focusBlocks.blocks && focusBlocks.blocks.length > 0 && (
        <div className="space-y-2">
          {focusBlocks.blocks.map((block, i) => {
            const isQuick = block.type === "quick_win";
            return (
              <div key={i}>
                <p className="text-xs font-medium text-on-surface-secondary flex items-center gap-1.5 mb-1.5">
                  {isQuick ? (
                    <Zap size={12} className="text-warning" />
                  ) : (
                    <Brain size={12} className="text-info" />
                  )}
                  {isQuick ? "Quick Wins" : "Deep Work"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {block.tasks.map((t, j) => (
                    <span
                      key={j}
                      className={`inline-flex px-2.5 py-1 text-xs rounded-lg font-medium ${
                        isQuick ? "bg-warning/10 text-warning" : "bg-info/10 text-info"
                      }`}
                    >
                      {t.title ?? `Task ${j + 1}`}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Reminders */}
      {remindersToday.length > 0 && (
        <div>
          <p className="text-xs font-medium text-on-surface-secondary flex items-center gap-1.5 mb-1.5">
            <Bell size={12} className="text-accent" />
            Reminders Today
          </p>
          <div className="space-y-0.5">
            {remindersToday.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-xs px-2 py-1">
                <span className="flex-1 truncate text-on-surface">{r.title}</span>
                {r.remindAt && (
                  <span className="shrink-0 text-[10px] text-on-surface-muted tabular-nums">
                    {r.remindAt.slice(11, 16)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Productivity insight */}
      {productivityContext?.insight && (
        <p className="text-[10px] text-on-surface-muted italic px-1">
          {productivityContext.insight}
        </p>
      )}
    </div>
  );
}

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

export function BulkResultCard({
  data,
  toolName,
  onSelectTask,
}: {
  data: Record<string, unknown>;
  toolName: string;
  onSelectTask?: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const items = (data.created ?? data.completed ?? data.updated ?? []) as {
    id?: string;
    title?: string;
    status?: string;
    priority?: number;
  }[];
  const count = (data.count as number) ?? items.length;

  if (items.length === 0) return null;

  const verb =
    toolName === "bulk_create_tasks"
      ? "Created"
      : toolName === "bulk_complete_tasks"
        ? "Completed"
        : "Updated";

  const visibleItems = expanded ? items : items.slice(0, 5);
  const hasMore = items.length > 5;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {verb} {count} task{count !== 1 ? "s" : ""}
        </button>
      </div>
      <div className="space-y-px">
        {visibleItems.map((item, i) => (
          <button
            key={item.id ?? i}
            onClick={() => item.id && onSelectTask?.(item.id)}
            className="w-full text-left px-2.5 py-2 rounded-lg text-xs hover:bg-surface-secondary/80 transition-colors flex items-center gap-2 group/row"
          >
            {toolName === "bulk_complete_tasks" ? (
              <CheckCircle2 size={14} className="text-success shrink-0" />
            ) : (
              <span className="w-3.5 h-3.5 rounded-full border-2 border-accent/30 shrink-0 flex items-center justify-center">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              </span>
            )}
            <span className="flex-1 min-w-0 truncate text-on-surface">{item.title}</span>
            {item.priority && item.priority >= 1 && item.priority <= 4 && (
              <span
                className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[item.priority]}`}
              >
                {PRIORITY_LABELS[item.priority]}
              </span>
            )}
          </button>
        ))}
        {hasMore && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-accent hover:text-accent-hover px-2.5 py-1.5 font-medium"
          >
            +{items.length - 5} more
          </button>
        )}
      </div>
    </div>
  );
}

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
