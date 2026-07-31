import { CompletionRing } from "../../components/CompletionRing";

interface TodayHeaderProps {
  totalCount: number;
  todayCompletedCount: number;
  ringTotal: number;
  onPlanMyDay?: () => void;
  onEndOfDay?: () => void;
  onWeeklyReview?: () => void;
}

/**
 * Today header with Phase 3 planning openers.
 * Plan My Day / End of Day / Weekly Review buttons appear only at the large
 * desktop breakpoint (`lg` / ≥900px). Keyboard and command-palette entries
 * remain available at all widths.
 */
export function TodayHeader({
  totalCount,
  todayCompletedCount,
  ringTotal,
  onPlanMyDay,
  onEndOfDay,
  onWeeklyReview,
}: TodayHeaderProps) {
  // The approved baseline disables Eat the Frog, so no Task Jar is rendered.
  return (
    <div className="mb-4 flex items-center justify-between md:mb-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-on-surface md:text-3xl">Today</h1>
        {onPlanMyDay && (
          <button
            type="button"
            onClick={onPlanMyDay}
            className="hidden rounded-full bg-accent-action/10 px-3 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-action/20 lg:inline-flex"
          >
            Plan My Day
          </button>
        )}
        {onEndOfDay && (
          <button
            type="button"
            onClick={onEndOfDay}
            className="hidden rounded-full bg-surface-tertiary px-3 py-1 text-xs font-medium text-on-surface-muted transition-colors hover:bg-surface-tertiary/80 lg:inline-flex"
          >
            End of Day
          </button>
        )}
        {onWeeklyReview && (
          <button
            type="button"
            onClick={onWeeklyReview}
            className="hidden rounded-full bg-surface-tertiary px-3 py-1 text-xs font-medium text-on-surface-muted transition-colors hover:bg-surface-tertiary/80 lg:inline-flex"
          >
            Weekly Review
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-on-surface-muted">
          {totalCount} {totalCount === 1 ? "task" : "tasks"}
        </span>
        {ringTotal > 0 && <CompletionRing completed={todayCompletedCount} total={ringTotal} />}
      </div>
    </div>
  );
}
