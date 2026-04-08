import React, { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import type { Task } from "../../core/types.js";
import { getPriority } from "../../core/priorities.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { useReducedMotion } from "./useReducedMotion.js";
import { CompletionBurst } from "./CompletionBurst.js";
import { checkmark, springSnappy, subtlePulse } from "../utils/animation-variants.js";
import { TaskItemContent } from "./task-item/TaskItemContent.js";
import { TaskItemActions } from "./task-item/TaskItemActions.js";
import { formatDuration, getRowClassName } from "./task-item/task-item-utils.js";
import { useToday } from "../hooks/useToday.js";

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
  onContextMenu?: (taskId: string, position: { x: number; y: number }) => void;
  isBlocked?: boolean;
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
  onContextMenu,
  isBlocked,
}: TaskItemProps) {
  const { settings } = useGeneralSettings();
  const { today } = useToday();
  const [animClass, setAnimClass] = useState("");
  const [showBurst, setShowBurst] = useState(false);
  const prevStatusRef = useRef(task.status);
  const reducedMotion = useReducedMotion();

  // Handle animation class and completion burst in a single effect (merged PERF-320)
  useEffect(() => {
    if (reducedMotion) {
      prevStatusRef.current = task.status;
      setAnimClass("");
      setShowBurst(false);
      return;
    }

    if (prevStatusRef.current === "pending" && task.status === "completed") {
      setAnimClass("animate-task-complete");
      setShowBurst(true);
      const animTimer = setTimeout(() => setAnimClass(""), 600);
      const burstTimer = setTimeout(() => setShowBurst(false), 600);
      prevStatusRef.current = task.status;
      return () => {
        clearTimeout(animTimer);
        clearTimeout(burstTimer);
      };
    }
    if (prevStatusRef.current === "completed" && task.status === "pending") {
      setAnimClass("animate-task-revive");
      const timer = setTimeout(() => setAnimClass(""), 500);
      prevStatusRef.current = task.status;
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = task.status;
  }, [reducedMotion, task.status]);

  const priority = task.priority ? getPriority(task.priority) : null;
  const isOverdue = task.dueDate && task.status === "pending" && task.dueDate.split("T")[0] < today;

  const handleClick = (e: React.MouseEvent) => {
    if (onMultiSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      onMultiSelect(task.id, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
      return;
    }
    onSelect(task.id);
  };

  const indentPadding = depth > 0 ? { paddingLeft: `${depth * 1.5 + 0.75}rem` } : undefined;

  const durationEnabled = settings.feature_duration !== "false";
  const hasDuration = durationEnabled && task.estimatedMinutes != null && task.estimatedMinutes > 0;
  const formattedDuration = hasDuration ? formatDuration(task.estimatedMinutes!) : "";

  const priorityColorClass = task.priority
    ? `border-priority-${task.priority}`
    : "border-on-surface-muted";
  const priorityHoverClass = task.priority
    ? `hover:bg-priority-${task.priority}/15`
    : "hover:bg-on-surface-muted/15";

  const rowClassName = getRowClassName(!!isMultiSelected, isSelected, task.status, task.priority);

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
      className={`group relative flex items-center gap-2 px-3 py-2 border-b border-border/30 cursor-pointer transition-all duration-150 ${animClass} ${rowClassName}`}
      onClick={handleClick}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault();
          onContextMenu(task.id, { x: e.clientX, y: e.clientY });
        }
      }}
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
      <motion.button
        variants={
          !reducedMotion && task.priority === 1 && task.status === "pending"
            ? subtlePulse
            : undefined
        }
        animate="animate"
        whileHover={reducedMotion ? undefined : { scale: 1.15 }}
        whileTap={reducedMotion ? undefined : { scale: 0.9 }}
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
        className={`relative w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
          task.status === "completed"
            ? "bg-success border-success"
            : showCheckbox && isMultiSelected
              ? "bg-accent border-accent"
              : `${priorityColorClass} ${priorityHoverClass}`
        }`}
      >
        {task.status === "completed" && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white">
            <motion.path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              variants={checkmark}
              initial={reducedMotion ? "animate" : "initial"}
              animate="animate"
              transition={springSnappy}
            />
          </svg>
        )}
        {showCheckbox && isMultiSelected && task.status !== "completed" && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white">
            <motion.path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              variants={checkmark}
              initial={reducedMotion ? "animate" : "initial"}
              animate="animate"
              transition={springSnappy}
            />
          </svg>
        )}
        <CompletionBurst active={showBurst} />
      </motion.button>
      {priority && <span className="sr-only">{priority.label}</span>}

      {/* Content area: title + metadata */}
      <TaskItemContent
        task={task}
        isOverdue={!!isOverdue}
        hasDuration={!!hasDuration}
        formattedDuration={formattedDuration}
        isBlocked={isBlocked}
        totalChildCount={totalChildCount}
        completedChildCount={completedChildCount}
        expanded={expanded}
      />

      {/* Hover action buttons */}
      <TaskItemActions task={task} onSelect={onSelect} onUpdateDueDate={onUpdateDueDate} />
    </div>
  );
});
