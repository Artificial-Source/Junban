import { ClipboardList } from "lucide-react";
import type { TaskDto } from "../api/client";
import { TaskItem } from "./TaskItem";
import { EmptyState } from "./EmptyState";

interface TaskListProps {
  tasks: TaskDto[];
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
  emptyMessage: string;
  todayKey: string;
}

export function TaskList({
  tasks,
  onToggle,
  onSelect,
  selectedTaskId,
  emptyMessage,
  todayKey,
}: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <EmptyState icon={<ClipboardList size={40} strokeWidth={1.25} />} title={emptyMessage} />
    );
  }

  return (
    <ul aria-label="Tasks" className="space-y-0">
      {tasks.map((task) => (
        <li key={task.id}>
          <TaskItem
            task={task}
            onToggle={onToggle}
            onSelect={onSelect}
            isSelected={selectedTaskId === task.id}
            todayKey={todayKey}
          />
        </li>
      ))}
    </ul>
  );
}
