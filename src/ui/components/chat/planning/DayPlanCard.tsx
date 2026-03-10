import { AlertTriangle, Zap, Brain, Bell } from "lucide-react";
import { WorkloadBar } from "./WorkloadBar.js";
import type { FocusBlock } from "./types.js";

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
