import { TaskList } from "../../components/TaskList.js";
import type { Task } from "../../../core/types.js";
import { formatTodayHeader } from "./today-utils.js";

interface TodayTaskListProps {
  todayTasks: Task[];
  overdueTasks: Task[];
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  onReorder?: (orderedIds: string[]) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
  onContextMenu?: (taskId: string, position: { x: number; y: number }) => void;
}

export function TodayTaskList({
  todayTasks,
  overdueTasks,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onReorder,
  onAddSubtask,
  onUpdateDueDate,
  onContextMenu,
}: TodayTaskListProps) {
  return (
    <div>
      <h2 className="text-base font-bold text-on-surface mb-1 px-1">{formatTodayHeader()}</h2>
      <div className="h-0.5 bg-accent mb-3 rounded-full" />
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
        selectedTaskIds={selectedTaskIds}
        onMultiSelect={onMultiSelect}
        onReorder={onReorder}
        onAddSubtask={onAddSubtask}
        onUpdateDueDate={onUpdateDueDate}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}
