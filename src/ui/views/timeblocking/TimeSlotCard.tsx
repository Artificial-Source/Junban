/**
 * Multi-task time slot card with ordered membership controls.
 */
import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import { useState } from "react";
import type { TaskDto, TimeSlotDto } from "../../api/client";
import {
  civilTimeToMinutes,
  formatTimeRangeLabel,
  isVirtualOccurrence,
  normalizeCivilTime,
} from "./timeblockingRange";

interface TimeSlotCardProps {
  slot: TimeSlotDto;
  tasksById: Map<string, TaskDto>;
  pixelsPerHour: number;
  workDayStart: string;
  color: string;
  selected?: boolean;
  mutationPending?: boolean;
  phase3VisualFixture?: boolean;
  onSelect: (occurrenceKey: string) => void;
  onOpenEditor: (occurrenceKey: string) => void;
  onToggleTask: (taskId: string) => void;
  onRemoveTask: (slotOwnerId: string, taskId: string) => void;
  onMoveTask: (slotOwnerId: string, taskId: string, direction: -1 | 1) => void;
  onDropTask: (slotOwnerId: string, taskId: string) => void;
  onResizePointerDown: (
    occurrenceKey: string,
    edge: "start" | "end",
    event: React.PointerEvent,
  ) => void;
}

const COLLAPSED_TASK_COUNT = 3;

export function TimeSlotCard({
  slot,
  tasksById,
  pixelsPerHour,
  workDayStart,
  color,
  selected = false,
  mutationPending = false,
  phase3VisualFixture = false,
  onSelect,
  onOpenEditor,
  onToggleTask,
  onRemoveTask,
  onMoveTask,
  onDropTask,
  onResizePointerDown,
}: TimeSlotCardProps) {
  const [expanded, setExpanded] = useState(false);
  const startMin = civilTimeToMinutes(slot.start) ?? 0;
  const endMin = civilTimeToMinutes(slot.end) ?? startMin + 60;
  const dayStartMin = civilTimeToMinutes(workDayStart) ?? 0;
  const duration = Math.max(0, endMin - startMin);
  const top = ((startMin - dayStartMin) / 60) * pixelsPerHour;
  const height = Math.max((duration / 60) * pixelsPerHour, 48);
  const virtual = isVirtualOccurrence(slot);
  const taskIds = slot.task_ids ?? [];
  const slotTasks = taskIds
    .map((id) => tasksById.get(id))
    .filter((task): task is TaskDto => Boolean(task));
  const completedCount = slotTasks.filter((task) => task.status === "completed").length;
  const needsCollapse = slotTasks.length > COLLAPSED_TASK_COUNT;
  const visibleTasks = expanded ? slotTasks : slotTasks.slice(0, COLLAPSED_TASK_COUNT);

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`time-slot-${slot.occurrence_key}`}
      data-occurrence-key={slot.occurrence_key}
      data-slot-id={slot.id}
      aria-label={`${slot.title} slot, ${normalizeCivilTime(slot.start)} to ${normalizeCivilTime(slot.end)}${virtual ? ", recurring series" : ""}`}
      aria-pressed={selected || undefined}
      className={`absolute left-1 right-1 z-10 overflow-hidden rounded-md border-2 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        selected ? "ring-2 ring-accent-action" : ""
      }`}
      style={{
        top,
        height,
        backgroundColor: `color-mix(in srgb, ${color} 10%, var(--color-surface))`,
        borderColor: `color-mix(in srgb, ${color} 40%, var(--color-border))`,
        borderLeftWidth: 4,
        borderLeftColor: color,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(slot.occurrence_key);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpenEditor(slot.occurrence_key);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenEditor(slot.occurrence_key);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/x-junban-task-id")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        const taskId = event.dataTransfer.getData("application/x-junban-task-id");
        if (!taskId) return;
        event.preventDefault();
        event.stopPropagation();
        onDropTask(slot.id, taskId);
      }}
    >
      <div
        data-resize-edge="start"
        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-20 hover:bg-accent-action/30"
        onPointerDown={(event) => {
          event.stopPropagation();
          onResizePointerDown(slot.occurrence_key, "start", event);
        }}
        aria-hidden="true"
      />

      <div className="px-2 py-1 h-full flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-on-surface truncate">
              {slot.title}
              <span className="ml-1.5 text-xs font-normal text-on-surface-secondary">
                {formatTimeRangeLabel(slot.start, slot.end)}
              </span>
            </div>
          </div>
          {slotTasks.length > 0 && (
            <span className="text-[10px] text-on-surface-muted flex-shrink-0">
              {completedCount}/{slotTasks.length}
            </span>
          )}
        </div>

        <div className="mt-1 space-y-0.5 min-h-0 overflow-auto">
          {visibleTasks.map((task, index) => {
            const absoluteIndex = expanded
              ? index
              : taskIds.indexOf(task.id) === -1
                ? index
                : taskIds.indexOf(task.id);
            const isCompleted = task.status === "completed";
            return (
              <div
                key={task.id}
                className="flex items-center gap-1 rounded px-0.5 py-0.5 text-xs hover:bg-surface/40"
                data-testid={`slot-task-${slot.occurrence_key}-${task.id}`}
              >
                <button
                  type="button"
                  className={`w-3 h-3 rounded-full border flex-shrink-0 flex items-center justify-center ${
                    isCompleted
                      ? "bg-success border-success"
                      : "border-on-surface-muted hover:border-accent-action"
                  }`}
                  aria-label={isCompleted ? `Uncomplete ${task.title}` : `Complete ${task.title}`}
                  disabled={mutationPending}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleTask(task.id);
                  }}
                />
                <span
                  className={`truncate flex-1 ${
                    isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
                  }`}
                >
                  {task.title}
                </span>
                {!phase3VisualFixture && (
                  <>
                    <button
                      type="button"
                      className="p-0.5 rounded text-on-surface-muted hover:text-on-surface disabled:opacity-40"
                      aria-label={`Move ${task.title} earlier in slot`}
                      disabled={mutationPending || absoluteIndex <= 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        onMoveTask(slot.id, task.id, -1);
                      }}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      className="p-0.5 rounded text-on-surface-muted hover:text-on-surface disabled:opacity-40"
                      aria-label={`Move ${task.title} later in slot`}
                      disabled={mutationPending || absoluteIndex >= taskIds.length - 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        onMoveTask(slot.id, task.id, 1);
                      }}
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      type="button"
                      className="p-0.5 rounded text-on-surface-muted hover:text-error disabled:opacity-40"
                      aria-label={`Remove ${task.title} from slot`}
                      disabled={mutationPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveTask(slot.id, task.id);
                      }}
                    >
                      <X size={12} />
                    </button>
                    <GripVertical
                      size={12}
                      className="text-on-surface-muted flex-shrink-0"
                      aria-hidden
                    />
                  </>
                )}
              </div>
            );
          })}
          {needsCollapse && (
            <button
              type="button"
              className="text-[11px] text-accent-foreground hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
            >
              {expanded ? "Show fewer" : `Show ${slotTasks.length - COLLAPSED_TASK_COUNT} more`}
            </button>
          )}
        </div>
      </div>

      <div
        data-resize-edge="end"
        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-20 hover:bg-accent-action/30"
        onPointerDown={(event) => {
          event.stopPropagation();
          onResizePointerDown(slot.occurrence_key, "end", event);
        }}
        aria-hidden="true"
      />
    </div>
  );
}
