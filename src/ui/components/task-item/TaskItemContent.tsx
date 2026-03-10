import {
  Calendar,
  Clock,
  Repeat,
  Bell,
} from "lucide-react";
import type { Task } from "../../../core/types.js";
import { FrogIcon, getDreadLevelColor } from "../DreadLevelSelector.js";
import { formatRecurrenceLabel } from "../RecurrencePicker.js";
import { hexToRgba } from "../../../utils/color.js";

interface TaskItemContentProps {
  task: Task;
  isOverdue: boolean;
  hasDuration: boolean;
  formattedDuration: string;
  isBlocked?: boolean;
  totalChildCount: number;
  completedChildCount: number;
  expanded?: boolean;
}

export function TaskItemContent({
  task,
  isOverdue,
  hasDuration,
  formattedDuration,
  isBlocked,
  totalChildCount,
  completedChildCount,
  expanded,
}: TaskItemContentProps) {
  const hasMetadataLine =
    task.tags.length > 0 || task.dueDate || task.recurrence || task.remindAt || hasDuration;

  return (
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
  );
}
