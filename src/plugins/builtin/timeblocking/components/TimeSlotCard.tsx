import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, Check } from "lucide-react";
import type { TimeSlot } from "../types.js";
import type { Task } from "../../../../core/types.js";
import { getSlotProgress, getSlotColor } from "../slot-helpers.js";
import { timeToMinutes } from "./TimelineColumn.js";

interface TimeSlotCardProps {
  slot: TimeSlot;
  tasks: Task[];
  projects: Array<{ id: string; color: string }>;
  pixelsPerHour: number;
  workDayStart: string;
  isConflicting?: boolean;
  onSlotClick: (slotId: string) => void;
  onTaskClick: (taskId: string) => void;
  onTaskToggle: (taskId: string) => void;
  onResizeStart: (slotId: string, edge: "top" | "bottom") => void;
}

const COLLAPSED_TASK_COUNT = 3;

function SortableSlotTask({
  task,
  onTaskClick,
  onTaskToggle,
}: {
  task: Task;
  onTaskClick: (taskId: string) => void;
  onTaskToggle: (taskId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: "slot-task", taskId: task.id } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const isCompleted = task.status === "completed";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1.5 py-0.5 px-1 rounded text-xs cursor-grab hover:bg-white/10"
      {...attributes}
      {...listeners}
    >
      <button
        className={`w-3 h-3 rounded-full border flex-shrink-0 flex items-center justify-center ${
          isCompleted
            ? "bg-success border-success"
            : "border-on-surface-muted hover:border-accent"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onTaskToggle(task.id);
        }}
      >
        {isCompleted && <Check size={8} className="text-white" />}
      </button>
      <span
        className={`truncate cursor-pointer ${
          isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onTaskClick(task.id);
        }}
      >
        {task.title}
      </span>
    </div>
  );
}

export function TimeSlotCard({
  slot,
  tasks,
  projects,
  pixelsPerHour,
  workDayStart,
  isConflicting = false,
  onSlotClick,
  onTaskClick,
  onTaskToggle,
  onResizeStart,
}: TimeSlotCardProps) {
  const [expanded, setExpanded] = useState(false);

  const startMin = timeToMinutes(slot.startTime);
  const endMin = timeToMinutes(slot.endTime);
  const dayStartMin = timeToMinutes(workDayStart);
  const durationMinutes = endMin - startMin;

  const top = ((startMin - dayStartMin) / 60) * pixelsPerHour;
  const height = (durationMinutes / 60) * pixelsPerHour;

  const slotTasks = slot.taskIds
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined);

  const progress = getSlotProgress(slot, (id) => tasks.find((t) => t.id === id));
  const color = getSlotColor(
    slot,
    (projectId) => projects.find((p) => p.id === projectId),
  );

  const needsCollapse = slotTasks.length > COLLAPSED_TASK_COUNT;
  const visibleTasks = expanded ? slotTasks : slotTasks.slice(0, COLLAPSED_TASK_COUNT);
  const hiddenCount = slotTasks.length - COLLAPSED_TASK_COUNT;

  // Slot is a droppable target
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `slot-drop-${slot.id}`,
    data: { type: "slot", slotId: slot.id },
  });

  return (
    <div
      ref={setDropRef}
      data-slot-id={slot.id}
      data-testid={`time-slot-${slot.id}`}
      className={`absolute left-1 right-1 z-10 rounded-md border-2 transition-all duration-150 select-none ${
        isConflicting ? "border-l-4 border-l-error" : ""
      } ${isOver ? "ring-2 ring-accent/50" : ""}`}
      style={{
        top,
        height: Math.max(height, 48),
        backgroundColor: `color-mix(in srgb, ${color} 10%, var(--color-surface))`,
        borderColor: `color-mix(in srgb, ${color} 40%, var(--color-border))`,
        borderLeftWidth: 4,
        borderLeftColor: color,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSlotClick(slot.id);
      }}
    >
      {/* Top resize handle */}
      <div
        className="absolute top-0 left-0 right-0 h-1 cursor-ns-resize z-20 hover:bg-accent/30 rounded-t-md"
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(slot.id, "top");
        }}
      />

      {/* Content */}
      <div className="px-2 py-1 overflow-hidden h-full flex flex-col">
        {/* Header row */}
        <div className="flex items-center justify-between min-w-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="text-sm font-medium text-on-surface truncate">
              {slot.title}
            </span>
            <span className="text-xs text-on-surface-secondary flex-shrink-0">
              {slot.startTime} – {slot.endTime}
            </span>
          </div>
          {/* Task countdown badge */}
          {progress.total > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary text-on-surface-secondary flex-shrink-0 ml-1"
              data-testid={`slot-progress-badge-${slot.id}`}
            >
              {progress.completed}/{progress.total}
            </span>
          )}
        </div>

        {/* Task list */}
        {slotTasks.length > 0 && (
          <div className="mt-1 flex-1 overflow-hidden">
            <SortableContext
              items={visibleTasks.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              {visibleTasks.map((task) => (
                <SortableSlotTask
                  key={task.id}
                  task={task}
                  onTaskClick={onTaskClick}
                  onTaskToggle={onTaskToggle}
                />
              ))}
            </SortableContext>

            {/* Expand/collapse button */}
            {needsCollapse && (
              <button
                className="flex items-center gap-0.5 text-[10px] text-accent hover:text-accent/80 mt-0.5 px-1"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
              >
                {expanded ? (
                  <>
                    <ChevronUp size={10} /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown size={10} /> +{hiddenCount} more
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {/* Progress bar */}
        {progress.total > 0 && (
          <div
            className="h-1 rounded-full bg-surface-secondary mt-auto flex-shrink-0"
            data-testid={`slot-progress-bar-${slot.id}`}
          >
            <div
              className="h-full rounded-full bg-success transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        )}
      </div>

      {/* Bottom resize handle */}
      <div
        className="absolute bottom-0 left-0 right-0 h-1 cursor-ns-resize z-20 hover:bg-accent/30 rounded-b-md"
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(slot.id, "bottom");
        }}
      />
    </div>
  );
}
