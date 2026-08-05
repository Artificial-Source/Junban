/**
 * Phase 2 TaskItem with priority indicator, tags, project badge, multiselect, and drag handle.
 * Preserves the legacy row layout, checkbox pattern, and hover actions.
 */
import { useState } from "react";
import { Calendar, Pencil, GripVertical } from "lucide-react";
import type { TaskDto, TagDto } from "../api/client";
import { calendarDayKey, formatDate } from "../lib/dates";

interface TaskItemProps {
  task: TaskDto;
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  isSelected: boolean;
  isMultiSelected?: boolean;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  todayKey: string;
  projectName?: string | null;
  projectColor?: string | null;
  tagMap?: Map<string, TagDto>;
  depth?: number;
  onIndent?: (id: string) => Promise<boolean>;
  onOutdent?: (id: string) => Promise<boolean>;
  /** Keyboard reorder: Alt+ArrowUp / Alt+ArrowDown on the handle. */
  onMove?: (id: string, direction: "up" | "down") => void;
  showDragHandle?: boolean;
  onDragStart?: (id: string) => void;
}

const PRIORITY_BORDER: Record<number, string> = {
  1: "border-l-3 border-l-priority-1",
  2: "border-l-3 border-l-priority-2",
  3: "border-l-2 border-l-priority-3",
  4: "",
};

export function TaskItem({
  task,
  onToggle,
  onSelect,
  isSelected,
  isMultiSelected = false,
  onMultiSelect,
  todayKey: today,
  projectName,
  projectColor,
  tagMap,
  depth = 0,
  onIndent,
  onOutdent,
  onMove,
  showDragHandle = false,
  onDragStart,
}: TaskItemProps) {
  const [pending, setPending] = useState(false);
  const dueDay = task.due_date ? calendarDayKey(task.due_date) : null;
  const isOverdue = dueDay !== null && task.status === "pending" && dueDay < today;
  const isCompleted = task.status === "completed";
  const isCancelled = task.status === "cancelled";

  const priorityBorder = task.priority ? (PRIORITY_BORDER[task.priority] ?? "") : "";

  const checkboxClassName = [
    "relative w-7 h-7 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors duration-200",
    isCompleted ? "bg-success border-success" : "border-accent-action hover:bg-accent-action/10",
  ]
    .filter(Boolean)
    .join(" ");

  function handleRowClick(e: React.MouseEvent) {
    if (onMultiSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      onMultiSelect(task.id, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
    }
  }

  return (
    <div
      data-density-row
      className={`density-row group relative flex items-center gap-2 px-3 border-b border-border/30 border-l-0 transition-all duration-150 ${priorityBorder} ${
        isSelected
          ? "bg-accent-action/5 ring-1 ring-accent-action/50"
          : isMultiSelected
            ? "bg-accent-action/5"
            : "hover:bg-surface-secondary"
      }`}
      style={{ paddingLeft: `${0.75 + depth * 1.5}rem` }}
      onClick={handleRowClick}
    >
      {/* Drag / hierarchy / reorder handle — keep w-7 to match the non-handle spacer width. */}
      {showDragHandle && (
        <button
          type="button"
          aria-label={
            onMove
              ? `Reorder task: ${task.title}. Alt+ArrowUp or Alt+ArrowDown to move.`
              : `Task handle: ${task.title}`
          }
          draggable={!!onDragStart}
          onDragStart={() => onDragStart?.(task.id)}
          className="flex h-7 w-7 flex-shrink-0 cursor-grab items-center justify-center text-on-surface-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" && onIndent) {
              e.preventDefault();
              void onIndent(task.id);
            } else if (e.key === "ArrowLeft" && onOutdent) {
              e.preventDefault();
              void onOutdent(task.id);
            } else if (e.altKey && e.key === "ArrowUp" && onMove) {
              e.preventDefault();
              onMove(task.id, "up");
            } else if (e.altKey && e.key === "ArrowDown" && onMove) {
              e.preventDefault();
              onMove(task.id, "down");
            }
          }}
        >
          <GripVertical size={14} aria-hidden="true" />
        </button>
      )}
      {/* Spacer when no drag handle to preserve alignment */}
      {!showDragHandle && <div aria-hidden="true" className="h-7 w-7 flex-shrink-0" />}

      {/* Completion checkbox */}
      <div className="relative flex-shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (pending) return;
            setPending(true);
            void onToggle(task.id)
              .catch(() => false)
              .finally(() => setPending(false));
          }}
          disabled={pending || isCancelled}
          aria-label={
            isCompleted ? `Mark task incomplete: ${task.title}` : `Complete task: ${task.title}`
          }
          aria-busy={pending || undefined}
          className={`${checkboxClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60`}
        >
          {isCompleted && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-surface">
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {!isCompleted && task.priority && (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: `var(--color-priority-${task.priority})` }}
            />
          )}
        </button>
      </div>

      {/* Open-details target — also the keyboard multi-select focus control. */}
      <button
        type="button"
        data-task-focus-control
        data-task-id={task.id}
        aria-label={`Task: ${task.title}${isMultiSelected ? ", selected" : ""}`}
        onClick={() => onSelect(task.id)}
        onKeyDown={(e) => {
          if (!onMultiSelect) return;
          // Space / Ctrl+Space toggle; Shift+Space ranges. Enter still opens details.
          if (e.key !== " " && e.key !== "Spacebar") return;
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            onMultiSelect(task.id, {
              ctrlKey: false,
              metaKey: false,
              shiftKey: true,
            });
          } else {
            // Plain Space and Ctrl/Meta+Space both toggle without opening the detail.
            onMultiSelect(task.id, {
              ctrlKey: true,
              metaKey: e.metaKey,
              shiftKey: false,
            });
          }
        }}
        className="min-w-0 flex-1 self-stretch rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm truncate ${
                isCompleted || isCancelled
                  ? "line-through text-on-surface-muted"
                  : "text-on-surface"
              }`}
            >
              {task.title}
            </span>
          </div>
          {/* Metadata row: tags + due date + project */}
          {(task.due_date || (task.tag_ids.length > 0 && tagMap) || projectName) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
              {task.tag_ids.length > 0 &&
                tagMap &&
                task.tag_ids.map((tagId) => {
                  const tag = tagMap.get(tagId);
                  if (!tag) return null;
                  return (
                    <span
                      key={tagId}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-tertiary px-1.5 font-mono text-xs text-on-surface-secondary"
                    >
                      {tag.color && (
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                      )}
                      {tag.name}
                    </span>
                  );
                })}
              {task.due_date && (
                <span
                  className={`text-xs flex items-center gap-1 flex-shrink-0 ${
                    isOverdue ? "text-error font-medium" : "text-on-surface-muted"
                  }`}
                >
                  <Calendar size={11} />
                  {formatDate(task.due_date)}
                </span>
              )}
              {projectName && (
                <span className="flex items-center gap-1 text-xs text-on-surface-muted flex-shrink-0">
                  {projectColor && (
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: projectColor }}
                    />
                  )}
                  {projectName}
                </span>
              )}
            </div>
          )}
        </div>
      </button>

      {/* Sibling actions */}
      <div className="relative flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity duration-150 flex-shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(task.id);
          }}
          aria-label={`Edit task: ${task.title}`}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-surface-tertiary text-on-surface-muted hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Pencil size={14} />
        </button>
      </div>
    </div>
  );
}
