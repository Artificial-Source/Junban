import { CompletionRing } from "../../components/CompletionRing";

interface TodayHeaderProps {
  totalCount: number;
  todayCompletedCount: number;
  ringTotal: number;
}

/**
 * Today header for Phase 2.
 * Plan My Day / End of Day are Phase 3 and intentionally absent (not disabled stubs).
 */
export function TodayHeader({ totalCount, todayCompletedCount, ringTotal }: TodayHeaderProps) {
  // The approved baseline disables Eat the Frog, so no Task Jar is rendered.
  return (
    <div className="flex items-center justify-between mb-4 md:mb-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl md:text-3xl font-bold text-on-surface">Today</h1>
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
