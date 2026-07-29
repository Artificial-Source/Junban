import { useMemo } from "react";
import { Inbox as InboxIcon } from "lucide-react";
import type { TaskDto } from "../api/client";
import { TaskInput } from "../components/TaskInput";
import { TaskList } from "../components/TaskList";
import { useToday } from "../hooks/useToday";

interface InboxProps {
  tasks: TaskDto[];
  onCreateTask: (title: string, dueDate: string | null) => Promise<boolean>;
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  autoFocusTrigger?: number;
}

export function Inbox({
  tasks,
  onCreateTask,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  autoFocusTrigger,
}: InboxProps) {
  const today = useToday();

  const inboxTasks = useMemo(() => {
    // Phase 1: all tasks have no project.
    // Inbox shows pending tasks without a due date (or any due date)
    // plus recently completed tasks.
    // Pending first, completed at the bottom.
    const filtered = tasks.filter((t) => t.status === "pending" || t.status === "completed");
    return filtered.sort((a, b) => {
      if (a.status === "completed" && b.status !== "completed") return 1;
      if (a.status !== "completed" && b.status === "completed") return -1;
      return 0;
    });
  }, [tasks]);

  const pendingCount = inboxTasks.filter((t) => t.status === "pending").length;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <InboxIcon size={24} className="text-accent-foreground" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Inbox</h1>
        <span className="text-sm text-on-surface-secondary">
          {pendingCount} {pendingCount === 1 ? "task" : "tasks"}
        </span>
      </div>
      <TaskInput
        onSubmit={(title) => onCreateTask(title, null)}
        autoFocusTrigger={autoFocusTrigger}
      />
      <TaskList
        tasks={inboxTasks}
        onToggle={onToggleTask}
        onSelect={onSelectTask}
        selectedTaskId={selectedTaskId}
        emptyMessage="Your inbox is empty. Add a task above!"
        todayKey={today}
      />
    </div>
  );
}
