import { useState, useMemo } from "react";
import { Inbox as InboxIcon } from "lucide-react";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import type { Task } from "../../core/types.js";

interface InboxProps {
  tasks: Task[];
  onCreateTask: (parsed: {
    title: string;
    priority: number | null;
    tags: string[];
    project: string | null;
    dueDate: Date | null;
    dueTime: boolean;
  }) => void;
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
  autoFocusTrigger?: number;
}

export function Inbox({
  tasks,
  onCreateTask,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onReorder,
  onAddSubtask,
  onUpdateDueDate,
  autoFocusTrigger,
}: InboxProps) {
  const [inboxViewTimeMs] = useState<number>(() => Date.now());

  const inboxTasks = useMemo(() => {
    const cutoffMs = inboxViewTimeMs - 14 * 24 * 60 * 60 * 1000;
    const isRecentCompletedTask = (t: Task): boolean => {
      if (t.status !== "completed") return false;
      if (!t.completedAt) return true;
      const completedAtMs = Date.parse(t.completedAt);
      if (Number.isNaN(completedAtMs)) return true;
      return completedAtMs >= cutoffMs;
    };

    const filtered = tasks.filter(
      (t) => !t.projectId && (t.status === "pending" || isRecentCompletedTask(t)),
    );

    // Pending tasks first, completed at the bottom
    return filtered.sort((a, b) => {
      if (a.status === "completed" && b.status !== "completed") return 1;
      if (a.status !== "completed" && b.status === "completed") return -1;
      return 0;
    });
  }, [tasks, inboxViewTimeMs]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <InboxIcon size={24} className="text-accent" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Inbox</h1>
        <span className="text-sm text-on-surface-muted">
          {(() => {
            const c = inboxTasks.filter((t) => t.status === "pending").length;
            return `${c} ${c === 1 ? "task" : "tasks"}`;
          })()}
        </span>
      </div>
      <TaskInput onSubmit={onCreateTask} autoFocusTrigger={autoFocusTrigger} />
      <TaskList
        tasks={inboxTasks}
        onToggle={onToggleTask}
        onSelect={onSelectTask}
        selectedTaskId={selectedTaskId}
        emptyMessage="Your inbox is empty. Add a task above!"
        selectedTaskIds={selectedTaskIds}
        onMultiSelect={onMultiSelect}
        onReorder={onReorder}
        onAddSubtask={onAddSubtask}
        onUpdateDueDate={onUpdateDueDate}
      />
    </div>
  );
}
