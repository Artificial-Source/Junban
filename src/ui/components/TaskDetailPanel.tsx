import { useEffect, useState } from "react";
import {
  X,
  Trash2,
  Calendar,
  Tag,
  Repeat,
  ChevronRight,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import type { Task, UpdateTaskInput } from "../../core/types.js";

interface TaskDetailPanelProps {
  task: Task;
  allTasks?: Task[];
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onIndent?: (id: string) => void;
  onOutdent?: (id: string) => void;
  onSelect?: (id: string) => void;
}

const PRIORITIES = [
  { value: 1, label: "P1", activeClass: "bg-priority-1/15 text-priority-1" },
  { value: 2, label: "P2", activeClass: "bg-priority-2/15 text-priority-2" },
  { value: 3, label: "P3", activeClass: "bg-priority-3/15 text-priority-3" },
  { value: 4, label: "P4", activeClass: "bg-priority-4/15 text-priority-4" },
];

export function TaskDetailPanel({
  task,
  allTasks = [],
  onUpdate,
  onDelete,
  onClose,
  onIndent,
  onOutdent,
  onSelect,
}: TaskDetailPanelProps) {
  const currentDueDateInput = task.dueDate ? task.dueDate.split("T")[0] : "";
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [dueDateInput, setDueDateInput] = useState(currentDueDateInput);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setDueDateInput(task.dueDate ? task.dueDate.split("T")[0] : "");
  }, [task]);

  const handleTitleBlur = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed });
    }
  };

  const handleDescriptionBlur = () => {
    const newDesc = description || null;
    if (newDesc !== task.description) {
      onUpdate(task.id, { description: newDesc });
    }
  };

  const handlePriorityClick = (priority: number) => {
    const newPriority = task.priority === priority ? null : priority;
    onUpdate(task.id, { priority: newPriority });
  };

  const handleDueDateBlur = () => {
    if (dueDateInput === currentDueDateInput) return;

    if (!dueDateInput) {
      onUpdate(task.id, { dueDate: null, dueTime: false });
      return;
    }

    const nextDueDate = new Date(`${dueDateInput}T00:00:00`).toISOString();
    onUpdate(task.id, { dueDate: nextDueDate, dueTime: false });
  };

  return (
    <div
      role="complementary"
      aria-label="Task details"
      className="w-96 border-l border-border flex flex-col bg-surface overflow-auto"
    >
      <div className="flex items-center justify-between p-4 border-b border-border">
        <span className="text-xs text-on-surface-muted font-mono">{task.id.slice(0, 8)}</span>
        <button
          onClick={onClose}
          aria-label="Close task details"
          className="text-on-surface-muted hover:text-on-surface-secondary transition-colors p-1 rounded-md hover:bg-surface-tertiary"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 p-4 space-y-4">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          className="w-full text-lg font-semibold bg-transparent border-none focus:outline-none focus:ring-0 text-on-surface"
        />

        <div>
          <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
            Priority
          </label>
          <div className="flex gap-2 mt-1">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                onClick={() => handlePriorityClick(p.value)}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                  task.priority === p.value
                    ? p.activeClass
                    : "bg-surface-tertiary text-on-surface-muted hover:text-on-surface-secondary"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={handleDescriptionBlur}
            placeholder="Add a description..."
            className="w-full mt-1 p-2 text-sm bg-surface-secondary border border-border rounded-md text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-1 focus:ring-accent min-h-[80px] resize-y"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
            <Calendar size={12} /> Due Date
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="date"
              value={dueDateInput}
              onChange={(e) => setDueDateInput(e.target.value)}
              onBlur={handleDueDateBlur}
              className="flex-1 px-2 py-1.5 text-sm bg-surface-secondary border border-border rounded-md text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {dueDateInput && (
              <button
                onClick={() => {
                  setDueDateInput("");
                  onUpdate(task.id, { dueDate: null, dueTime: false });
                }}
                className="text-xs px-2 py-1.5 rounded-md bg-surface-tertiary text-on-surface-secondary hover:text-on-surface"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {task.tags.length > 0 && (
          <div>
            <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
              <Tag size={12} /> Tags
            </label>
            <div className="flex gap-1.5 mt-1 flex-wrap">
              {task.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="text-xs px-2 py-0.5 rounded-md bg-surface-tertiary text-on-surface-secondary"
                >
                  #{tag.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {task.recurrence && (
          <div>
            <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
              <Repeat size={12} /> Recurrence
            </label>
            <p className="text-sm mt-1 text-on-surface">{task.recurrence}</p>
          </div>
        )}

        {/* Sub-task hierarchy controls */}
        {(onIndent || onOutdent) && (
          <div>
            <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
              Hierarchy
            </label>
            <div className="flex gap-2 mt-1">
              {onIndent && (
                <button
                  onClick={() => onIndent(task.id)}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-surface-tertiary text-on-surface-secondary hover:text-on-surface transition-colors"
                  title="Make sub-task of previous sibling"
                >
                  <ArrowRight size={12} /> Indent
                </button>
              )}
              {onOutdent && task.parentId && (
                <button
                  onClick={() => onOutdent(task.id)}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-surface-tertiary text-on-surface-secondary hover:text-on-surface transition-colors"
                  title="Move up one level"
                >
                  <ArrowLeft size={12} /> Outdent
                </button>
              )}
            </div>
            {task.parentId && (
              <p className="text-xs text-on-surface-muted mt-1">
                Sub-task of{" "}
                <button
                  className="text-accent hover:underline"
                  onClick={() => onSelect?.(task.parentId!)}
                >
                  {allTasks.find((t) => t.id === task.parentId)?.title ?? task.parentId.slice(0, 8)}
                </button>
              </p>
            )}
          </div>
        )}

        {/* Sub-tasks list */}
        {allTasks.filter((t) => t.parentId === task.id).length > 0 && (
          <div>
            <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
              <ChevronRight size={12} /> Sub-tasks
            </label>
            <div className="mt-1 space-y-1">
              {allTasks
                .filter((t) => t.parentId === task.id)
                .map((child) => (
                  <button
                    key={child.id}
                    onClick={() => onSelect?.(child.id)}
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-tertiary transition-colors"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${
                        child.status === "completed"
                          ? "bg-success border-success"
                          : "border-on-surface-muted"
                      }`}
                    />
                    <span
                      className={`text-sm ${
                        child.status === "completed"
                          ? "line-through text-on-surface-muted"
                          : "text-on-surface"
                      }`}
                    >
                      {child.title}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
            Created
          </label>
          <p className="text-sm mt-1 text-on-surface-muted">
            {new Date(task.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      <div className="p-4 border-t border-border">
        <button
          onClick={() => onDelete(task.id)}
          className="text-sm text-error hover:text-error/80 flex items-center gap-1.5 transition-colors"
        >
          <Trash2 size={14} />
          Delete task
        </button>
      </div>
    </div>
  );
}
