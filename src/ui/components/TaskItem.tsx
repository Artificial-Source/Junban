import React, { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  GripVertical,
  Pencil,
  Repeat,
  Bell,
} from "lucide-react";
import type { Task } from "../../core/types.js";
import { getPriority } from "../../core/priorities.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { FrogIcon, getDreadLevelColor } from "./DreadLevelSelector.js";
import { DatePicker } from "./DatePicker.js";
import { formatRecurrenceLabel } from "./RecurrencePicker.js";
import { hexToRgba } from "../../utils/color.js";
import { useReducedMotion } from "./useReducedMotion.js";
import { CompletionBurst } from "./CompletionBurst.js";
import { checkmark, springSnappy, subtlePulse } from "../utils/animation-variants.js";

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
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [animClass, setAnimClass] = useState("");
  const prevStatusRef = useRef(task.status);

  useEffect(() => {
    if (prevStatusRef.current === "pending" && task.status === "completed") {
      setAnimClass("animate-task-complete");
      const timer = setTimeout(() => setAnimClass(""), 600);
      prevStatusRef.current = task.status;
      return () => clearTimeout(timer);
    }
    if (prevStatusRef.current === "completed" && task.status === "pending") {
      setAnimClass("animate-task-revive");
      const timer = setTimeout(() => setAnimClass(""), 500);
      prevStatusRef.current = task.status;
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = task.status;
  }, [task.status]);

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

  const durationEnabled = settings.feature_duration !== "false";
  const hasDuration = durationEnabled && task.estimatedMinutes != null && task.estimatedMinutes > 0;
  const formattedDuration = hasDuration
    ? task.estimatedMinutes! < 60
      ? `${task.estimatedMinutes}m`
      : Number.isInteger(task.estimatedMinutes! / 60)
        ? `${task.estimatedMinutes! / 60}h`
        : `${(task.estimatedMinutes! / 60).toFixed(1)}h`
    : "";

  const hasMetadataLine =
    task.tags.length > 0 || task.dueDate || task.recurrence || task.remindAt || hasDuration;

  // Priority-based circle colors
  const reducedMotion = useReducedMotion();
  const [showBurst, setShowBurst] = useState(false);

  // Trigger burst on completion
  useEffect(() => {
    if (prevStatusRef.current === "pending" && task.status === "completed") {
      setShowBurst(true);
      const timer = setTimeout(() => setShowBurst(false), 600);
      return () => clearTimeout(timer);
    }
  }, [task.status]);

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
      className={`group relative flex items-center gap-2 px-3 py-2 border-b border-border/30 cursor-pointer transition-all duration-150 ${animClass} ${
        isMultiSelected
          ? "bg-accent/10 ring-1 ring-accent"
          : isSelected
            ? "bg-accent/5 ring-1 ring-accent/50"
            : task.status !== "completed" && task.priority && PRIORITY_ROW_STYLES[task.priority]
              ? `${PRIORITY_ROW_STYLES[task.priority].bg} hover:bg-surface-secondary`
              : "hover:bg-surface-secondary"
      } ${task.status !== "completed" && task.priority && PRIORITY_ROW_STYLES[task.priority] ? PRIORITY_ROW_STYLES[task.priority].border : ""}`}
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

          {/* Duration badge */}
          {hasDuration && (
            <span className="text-xs px-1.5 py-0 rounded-md bg-surface-tertiary text-on-surface-secondary font-mono flex items-center gap-0.5 flex-shrink-0">
              <Clock size={10} />
              {formattedDuration}
            </span>
          )}

          {/* Dread level indicator */}
          {task.dreadLevel != null && task.dreadLevel > 0 && task.status !== "completed" && (
            <span className="flex-shrink-0" title={`Dread level: ${task.dreadLevel}/5`}>
              <FrogIcon size={14} color={getDreadLevelColor(task.dreadLevel).fill} />
            </span>
          )}

          {/* Blocked badge */}
          {isBlocked && task.status === "pending" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-error/10 text-error flex-shrink-0">
              Blocked
            </span>
          )}

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
            {task.remindAt && <Bell size={12} className="text-warning flex-shrink-0" />}
            {task.recurrence && (
              <span className="text-xs flex items-center gap-0.5 text-on-surface-muted flex-shrink-0">
                <Repeat size={11} />
                {formatRecurrenceLabel(task.recurrence)}
              </span>
            )}
            {hasDuration && (
              <span className="text-xs flex items-center gap-0.5 text-on-surface-muted flex-shrink-0">
                <Clock size={11} />
                {formattedDuration}
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
