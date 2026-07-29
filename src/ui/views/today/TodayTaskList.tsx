import { TaskList } from "../../components/TaskList";
import type { TaskDto } from "../../api/client";
import { formatTodayHeader } from "../../lib/dates";

interface TodayTaskListProps {
  todayTasks: TaskDto[];
  overdueTasks: TaskDto[];
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  todayKey: string;
}

export function TodayTaskList({
  todayTasks,
  overdueTasks,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  todayKey,
}: TodayTaskListProps) {
  return (
    <div>
      <h2 className="text-base font-bold text-on-surface mb-1 px-1">{formatTodayHeader()}</h2>
      <div className="h-0.5 bg-accent-action mb-3 rounded-full" />
      <TaskList
        tasks={todayTasks}
        onToggle={onToggleTask}
        onSelect={onSelectTask}
        selectedTaskId={selectedTaskId}
        emptyMessage={
          overdueTasks.length === 0
            ? "No tasks for today. Add one above to get started!"
            : "Nothing else due today."
        }
        todayKey={todayKey}
      />
    </div>
  );
}
