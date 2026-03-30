import { CompletionRing } from "../../components/CompletionRing.js";
import { TaskJar } from "../../components/TaskJar.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";
import type { Task } from "../../../core/types.js";

interface TodayHeaderProps {
  totalCount: number;
  todayCompletedCount: number;
  ringTotal: number;
  tasks: Task[];
  onSelectTask: (id: string) => void;
  onPlanMyDay: () => void;
  onEndOfDay: () => void;
  onWeeklyReview: () => void;
}

export function TodayHeader({
  totalCount,
  todayCompletedCount,
  ringTotal,
  tasks,
  onSelectTask,
  onPlanMyDay,
  onEndOfDay,
  onWeeklyReview,
}: TodayHeaderProps) {
  const { settings } = useGeneralSettings();
  const showTaskJar = settings.eat_the_frog_enabled !== "false";
  const showWeeklyReview = settings.feature_stats !== "false";

  return (
    <div className="flex items-center justify-between mb-4 md:mb-6">
      <div className="flex items-center gap-2 md:gap-3 flex-wrap">
        <h1 className="text-2xl md:text-3xl font-bold text-on-surface">Today</h1>
        <button
          onClick={onPlanMyDay}
          className="hidden md:inline-flex px-3 py-1 text-xs font-medium rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
        >
          Plan My Day
        </button>
        <button
          onClick={onEndOfDay}
          className="hidden md:inline-flex px-3 py-1 text-xs font-medium rounded-full bg-surface-tertiary text-on-surface-muted hover:bg-surface-tertiary/80 transition-colors"
        >
          End of Day
        </button>
        {showWeeklyReview && (
          <button
            onClick={onWeeklyReview}
            className="hidden md:inline-flex px-3 py-1 text-xs font-medium rounded-full bg-surface-tertiary text-on-surface-muted hover:bg-surface-tertiary/80 transition-colors"
          >
            Weekly Review
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        {showTaskJar && <TaskJar tasks={tasks} onSelectTask={onSelectTask} />}
        <span className="text-sm text-on-surface-muted">
          {totalCount} {totalCount === 1 ? "task" : "tasks"}
        </span>
        {ringTotal > 0 && <CompletionRing completed={todayCompletedCount} total={ringTotal} />}
      </div>
    </div>
  );
}
