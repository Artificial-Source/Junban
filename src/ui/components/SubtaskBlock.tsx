import { Check, GripVertical, ArrowRight } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "../../core/types.js";

export interface SubtaskBlockProps {
  task: Task;
  isEditing: boolean;
  editTitle: string;
  isFocused: boolean;
  onEditTitleChange: (val: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggle?: (id: string) => void;
  onSelect?: (id: string) => void;
  dragHandleProps?: Record<string, unknown>;
  style?: React.CSSProperties;
  innerRef?: React.Ref<HTMLDivElement>;
}

export function SubtaskBlock({
  task,
  isEditing,
  editTitle,
  isFocused,
  onEditTitleChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggle,
  onSelect,
  dragHandleProps,
  style,
  innerRef,
}: SubtaskBlockProps) {
  const priorityColorClass = task.priority
    ? `border-priority-${task.priority}`
    : "border-on-surface-muted";
  const priorityHoverClass = task.priority
    ? `hover:bg-priority-${task.priority}/15`
    : "hover:bg-on-surface-muted/15";

  return (
    <div
      ref={innerRef}
      style={style}
      className={`group/subtask flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ${
        isFocused ? "bg-surface-tertiary" : "hover:bg-surface-tertiary"
      }`}
    >
      {/* Drag handle */}
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          className="cursor-grab text-on-surface-muted/40 hover:text-on-surface-muted opacity-0 group-hover/subtask:opacity-100 transition-opacity select-none"
        >
          <GripVertical size={14} />
        </span>
      )}

      {/* Checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.(task.id);
        }}
        className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
          task.status === "completed"
            ? "bg-success border-success"
            : `${priorityColorClass} ${priorityHoverClass}`
        }`}
      >
        {task.status === "completed" && <Check size={10} className="text-white" />}
      </button>

      {/* Title or edit input */}
      {isEditing ? (
        <input
          type="text"
          value={editTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSaveEdit();
            if (e.key === "Escape") onCancelEdit();
          }}
          onBlur={onSaveEdit}
          autoFocus
          className="flex-1 text-sm bg-transparent border-none outline-none text-on-surface"
        />
      ) : (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onStartEdit();
          }}
          className={`flex-1 text-sm cursor-text select-none ${
            task.status === "completed" ? "line-through text-on-surface-muted" : "text-on-surface"
          }`}
        >
          {task.title}
        </span>
      )}

      {/* Navigate arrow */}
      {onSelect && !isEditing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelect(task.id);
          }}
          className="opacity-0 group-hover/subtask:opacity-100 p-0.5 rounded text-on-surface-muted hover:text-on-surface transition-all"
          title="Open sub-task"
        >
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

export function SortableSubtaskBlock(
  props: Omit<SubtaskBlockProps, "dragHandleProps" | "style" | "innerRef">,
) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: props.task.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <SubtaskBlock
      {...props}
      dragHandleProps={{ ...attributes, ...listeners }}
      style={style}
      innerRef={setNodeRef}
    />
  );
}
