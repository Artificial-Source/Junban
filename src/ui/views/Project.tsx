import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import type { Task, Project as ProjectType } from "../../core/types.js";

interface ProjectProps {
  project: ProjectType;
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

export function Project({
  project,
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
}: ProjectProps) {
  const projectTasks = tasks.filter((t) => t.status === "pending" && t.projectId === project.id);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        {project.icon ? (
          <span className="text-2xl leading-none flex-shrink-0">{project.icon}</span>
        ) : (
          <div
            className="w-4 h-4 rounded-full flex-shrink-0"
            style={{ backgroundColor: project.color }}
          />
        )}
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">{project.name}</h1>
        <span className="text-sm text-on-surface-muted">{projectTasks.length} tasks</span>
      </div>
      <TaskInput
        onSubmit={onCreateTask}
        placeholder={`Add a task to ${project.name}...`}
        autoFocusTrigger={autoFocusTrigger}
      />
      <TaskList
        tasks={projectTasks}
        onToggle={onToggleTask}
        onSelect={onSelectTask}
        selectedTaskId={selectedTaskId}
        emptyMessage="No tasks in this project yet."
        selectedTaskIds={selectedTaskIds}
        onMultiSelect={onMultiSelect}
        onReorder={onReorder}
        onAddSubtask={onAddSubtask}
        onUpdateDueDate={onUpdateDueDate}
      />
    </div>
  );
}
