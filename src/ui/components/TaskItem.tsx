import React, { useState } from "react";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Pencil,
  Repeat,
  Bell,
} from "lucide-react";
import type { Task } from "../../core/types.js";
import { getPriority } from "../../core/priorities.js";
import { DatePicker } from "./DatePicker.js";
import { formatRecurrenceLabel } from "./RecurrencePicker.js";
import { hexToRgba } from "../../utils/color.js";

/** Priority → row styling: left border + optional background wash */
const PRIORITY_ROW_STYLES: Record<number, { border: string; bg: string }> = {
  1: { border: "border-l-3 border-l-priority-1", bg: "bg-priority-1/[0.06]" },
  2: { border: "border-l-3 border-l-priority-2", bg: "bg-priority-2/[0.04]" },
  3: { border: "border-l-2 border-l-priority-3", bg: "" },
  4: { border: "", bg: "" },
};

interface TaskItemProps {
  task: Task;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  isSelected: boolean;
  isMultiSelected?: boolean;
  showCheckbox?: boolean;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  dragHandleProps?: Record<string, unknown>;
  style?: React.CSSProperties;
  innerRef?: React.Ref<HTMLDivElement>;
  depth?: number;
  completedChildCount?: number;
  totalChildCount?: number;
  expanded?: boolean;
  onToggleExpand?: (id: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
}

export const TaskItem = React.memo(function TaskItem({
  task,
  onToggle,
  onSelect,
  isSelected,
  isMultiSelected,
  showCheckbox,
  onMultiSelect,
  dragHandleProps,
  style,
  innerRef,
  depth = 0,
  completedChildCount = 0,
  totalChildCount = 0,
  expanded,
  onToggleExpand,
  onUpdateDueDate,
}: TaskItemProps) {
  const [showDatePicker, setShowDatePicker] = useState(false);
  const priority = task.priority ? getPriority(task.priority) : null;
  const isOverdue =
    task.dueDate && task.status === "pending" && new Date(task.dueDate) < new Date();

  const handleClick = (e: React.MouseEvent) => {
    if (onMultiSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      onMultiSelect(task.id, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
      return;
    }
    onSelect(task.id);
  };

  const indentPadding = depth > 0 ? { paddingLeft: `${depth * 1.5 + 0.75}rem` } : undefined;

  const hasMetadataLine =
    task.tags.length > 0 || task.dueDate || task.recurrence || (task as any).remindAt;

  // Priority-based circle colors
  const priorityColorClass = task.priority
    ? `border-priority-${task.priority}`
    : "border-on-surface-muted";
  const priorityHoverClass = task.priority
    ? `hover:bg-priority-${task.priority}/15`
    : "hover:bg-on-surface-muted/15";

  return (
    <div
      ref={innerRef}
      style={{ ...style, ...indentPadding }}
      role="button"
      tabIndex={0}
      aria-label={`Task: ${task.title}${depth > 0 ? ` (sub-task, level ${depth})` : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(task.id);
        }
      }}
      className={`group relative flex items-center gap-2 px-3 py-2 border-b border-border/30 cursor-pointer transition-colors duration-150 ${
        isMultiSelected
          ? "bg-accent/10 ring-1 ring-accent"
          : isSelected
            ? "bg-accent/5 ring-1 ring-accent/50"
            : task.status !== "completed" && task.priority && PRIORITY_ROW_STYLES[task.priority]
              ? `${PRIORITY_ROW_STYLES[task.priority].bg} hover:bg-surface-secondary`
              : "hover:bg-surface-secondary"
      } ${task.status !== "completed" && task.priority && PRIORITY_ROW_STYLES[task.priority] ? PRIORITY_ROW_STYLES[task.priority].border : ""}`}
      onClick={handleClick}
    >
      {/* Vertical connector line for nested tasks */}
      {depth > 0 && (
        <div
          className="absolute top-0 bottom-0 border-l border-border/30"
          style={{ left: `${(depth - 1) * 1.5 + 1.5}rem` }}
        />
      )}

      {/* Expand/collapse toggle for parents */}
      {totalChildCount > 0 && onToggleExpand && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(task.id);
          }}
          aria-label={expanded ? "Collapse sub-tasks" : `Expand ${totalChildCount} sub-tasks`}
          className="text-on-surface-muted hover:text-on-surface-secondary flex-shrink-0 -ml-1"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      )}

      {/* Drag handle */}
      {dragHandleProps && (
        <span
          {...dragHandleProps}
          role="img"
          aria-label="Drag to reorder"
          className="cursor-grab text-on-surface-muted hover:text-on-surface-secondary select-none opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        >
          <GripVertical size={16} />
        </span>
      )}

      {/* Priority-colored circle (unified checkbox + completion) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (showCheckbox && onMultiSelect) {
            onMultiSelect(task.id, { ctrlKey: true, metaKey: false, shiftKey: false });
          } else {
            onToggle(task.id);
          }
        }}
        aria-label={
          showCheckbox
            ? isMultiSelected
              ? "Deselect task"
              : "Select task"
            : task.status === "completed"
              ? "Mark task incomplete"
              : `Complete task${priority ? ` (${priority.label})` : ""}`
        }
        className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
          task.status === "completed"
            ? "bg-success border-success"
            : showCheckbox && isMultiSelected
              ? "bg-accent border-accent"
              : `${priorityColorClass} ${priorityHoverClass}`
        }`}
      >
        {task.status === "completed" && <Check size={12} className="text-white" />}
        {showCheckbox && isMultiSelected && task.status !== "completed" && (
          <Check size={12} className="text-white" />
        )}
      </button>
      {priority && <span className="sr-only">{priority.label}</span>}

      {/* Content area: title + metadata */}
      <div className="flex-1 min-w-0">
        {/* Line 1: Title + subtask progress */}
        <div className="flex items-center gap-2">
          <span
            className={`text-sm truncate ${
              task.status === "completed" ? "line-through text-on-surface-muted" : "text-on-surface"
            }`}
          >
            {task.title}
          </span>

          {/* Subtask progress indicator (when collapsed) */}
          {totalChildCount > 0 && !expanded && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className="h-1 w-12 rounded-full bg-surface-tertiary overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{
                    width: `${totalChildCount > 0 ? (completedChildCount / totalChildCount) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="text-xs text-on-surface-muted">
                {completedChildCount}/{totalChildCount}
              </span>
            </div>
          )}
        </div>

        {/* Line 2: Metadata (tags, due date, reminder, recurrence) */}
        {hasMetadataLine && (
          <div className="flex items-center gap-2 mt-0.5">
            {task.tags.map((tag) => (
              <span
                key={tag.id}
                className={`font-mono text-xs px-1.5 py-0 rounded-md ${
                  tag.color ? "" : "bg-surface-tertiary text-on-surface-secondary"
                }`}
                style={
                  tag.color
                    ? { backgroundColor: hexToRgba(tag.color, 0.15), color: tag.color }
                    : undefined
                }
              >
                {tag.name}
              </span>
            ))}
            {task.dueDate && (
              <span
                className={`text-xs flex items-center gap-1 flex-shrink-0 ${
                  isOverdue ? "text-error font-medium" : "text-on-surface-muted"
                }`}
              >
                <Calendar size={11} />
                {new Date(task.dueDate).toLocaleDateString()}
              </span>
            )}
            {(task as any).remindAt && <Bell size={12} className="text-warning flex-shrink-0" />}
            {task.recurrence && (
              <span className="text-xs flex items-center gap-0.5 text-on-surface-muted flex-shrink-0">
                <Repeat size={11} />
                {formatRecurrenceLabel(task.recurrence)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Hover action buttons */}
      <div className="relative flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150 flex-shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelect(task.id);
          }}
          aria-label="Edit task"
          className="p-2 md:p-1 rounded hover:bg-surface-tertiary text-on-surface-muted hover:text-on-surface transition-colors"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowDatePicker((prev) => !prev);
          }}
          aria-label="Set due date"
          className="p-2 md:p-1 rounded hover:bg-surface-tertiary text-on-surface-muted hover:text-on-surface transition-colors"
        >
          <Calendar size={14} />
        </button>
        {showDatePicker && (
          <DatePicker
            value={task.dueDate}
            onChange={(date) => {
              if (onUpdateDueDate) {
                onUpdateDueDate(task.id, date);
              }
              setShowDatePicker(false);
            }}
            onClose={() => setShowDatePicker(false)}
          />
        )}
      </div>
    </div>
  );
});
