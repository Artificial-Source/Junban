import { CompletionRing } from "../../components/CompletionRing";
import { Dices } from "lucide-react";

interface TodayHeaderProps {
  totalCount: number;
  todayCompletedCount: number;
  ringTotal: number;
  onPlanMyDay: () => void;
  onEndOfDay: () => void;
}

export function TodayHeader({
  totalCount,
  todayCompletedCount,
  ringTotal,
  onPlanMyDay,
  onEndOfDay,
}: TodayHeaderProps) {
  // Phase 1: Task Jar is visible but disabled; no random task selection.
  return (
    <div className="flex items-center justify-between mb-4 md:mb-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl md:text-3xl font-bold text-on-surface">Today</h1>
        <button
          onClick={onPlanMyDay}
          disabled
          aria-label="Plan My Day (unavailable)"
          className="hidden lg:inline-flex px-3 py-1 text-xs font-medium rounded-full bg-accent-action/10 text-accent-foreground hover:bg-accent-action/20 transition-colors opacity-50 cursor-not-allowed"
        >
          Plan My Day
        </button>
        <button
          onClick={onEndOfDay}
          disabled
          aria-label="End of Day (unavailable)"
          className="hidden lg:inline-flex px-3 py-1 text-xs font-medium rounded-full bg-surface-tertiary text-on-surface-muted hover:bg-surface-tertiary/80 transition-colors opacity-50 cursor-not-allowed"
        >
          End of Day
        </button>
      </div>
      <div className="flex items-center gap-3">
        <button
          disabled
          aria-label="Task Jar (unavailable)"
          title="Task Jar - pick a random task"
          className="p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors opacity-50 cursor-not-allowed"
        >
          <Dices size={20} />
        </button>
        <span className="text-sm text-on-surface-muted">
          {totalCount} {totalCount === 1 ? "task" : "tasks"}
        </span>
        {ringTotal > 0 && <CompletionRing completed={todayCompletedCount} total={ringTotal} />}
      </div>
    </div>
  );
}
