import { useDraggable } from "@dnd-kit/core";
import { Lock, Repeat, AlertTriangle } from "lucide-react";
import type { TimeBlock } from "../types.js";

interface TimeBlockCardProps {
  block: TimeBlock;
  pixelsPerHour: number;
  workDayStart: string;
  color?: string;
  isConflicting?: boolean;
  conflictTooltip?: string;
  taskStatus?: "pending" | "completed" | "cancelled";
  isEditing?: boolean;
  editingTitle?: string;
  onEditingTitleChange?: (title: string) => void;
  onEditingConfirm?: () => void;
  onEditingCancel?: () => void;
  onResizeStart: (blockId: string, edge: "top" | "bottom") => void;
  onClick: (blockId: string) => void;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function formatTimeRange(start: string, end: string): string {
  return `${start} – ${end}`;
}

function formatDuration(startTime: string, endTime: string): string {
  const minutes = timeToMinutes(endTime) - timeToMinutes(startTime);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function TimeBlockCard({
  block,
  pixelsPerHour,
  workDayStart,
  color,
  isConflicting = false,
  conflictTooltip,
  taskStatus,
  isEditing = false,
  editingTitle = "",
  onEditingTitleChange,
  onEditingConfirm,
  onEditingCancel,
  onResizeStart,
  onClick,
}: TimeBlockCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: block.id,
    data: { type: "block", block },
  });

  const startMin = timeToMinutes(block.startTime);
  const endMin = timeToMinutes(block.endTime);
  const dayStartMin = timeToMinutes(workDayStart);
  const durationMinutes = endMin - startMin;
  const isCompact = durationMinutes < 45;

  const top = ((startMin - dayStartMin) / 60) * pixelsPerHour;
  const height = (durationMinutes / 60) * pixelsPerHour;

  const resolvedColor = color ?? block.color ?? "var(--color-accent)";

  const style: React.CSSProperties = {
    top,
    height,
    ...(transform
      ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
      : {}),
  };

  const priorityCircle =
    taskStatus === "completed"
      ? "bg-success border-success"
      : "border-on-surface-muted";

  return (
    <div
      ref={setNodeRef}
      data-block-id={block.id}
      data-testid={`time-block-${block.id}`}
      className={`absolute left-1 right-1 z-10 rounded-md border transition-all duration-150 cursor-grab group select-none ${
        isDragging ? "opacity-30" : "hover:shadow-md"
      } ${isConflicting ? "border-l-3 border-l-error" : "border-border"}`}
      style={{
        ...style,
        backgroundColor: `color-mix(in srgb, ${resolvedColor} 15%, var(--color-surface))`,
        borderColor: isConflicting ? undefined : `color-mix(in srgb, ${resolvedColor} 30%, var(--color-border))`,
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (!isEditing) onClick(block.id);
      }}
      {...attributes}
      {...listeners}
    >
      {/* Conflict warning badge */}
      {isConflicting && (
        <div
          className="absolute top-1 right-1 z-30"
          title={conflictTooltip ?? "Overlapping block"}
          data-testid={`conflict-badge-${block.id}`}
        >
          <AlertTriangle size={12} className="text-error" />
        </div>
      )}

      {/* Top resize handle */}
      <div
        className="absolute top-0 left-0 right-0 h-1 cursor-ns-resize z-20 hover:bg-accent/30 rounded-t-md"
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(block.id, "top");
        }}
      />

      {/* Content */}
      <div className="px-2 py-1 overflow-hidden h-full flex flex-col justify-center">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Task checkbox (if linked) */}
          {block.taskId && (
            <div
              className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${priorityCircle}`}
            />
          )}

          {/* Title */}
          {isEditing ? (
            <input
              type="text"
              className="flex-1 text-sm bg-transparent border-none outline-none text-on-surface"
              value={editingTitle}
              onChange={(e) => onEditingTitleChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onEditingConfirm?.();
                if (e.key === "Escape") onEditingCancel?.();
              }}
              onBlur={() => onEditingConfirm?.()}
              autoFocus
            />
          ) : (
            <span
              className={`text-sm font-medium truncate flex-1 ${
                taskStatus === "completed"
                  ? "line-through text-on-surface-muted"
                  : "text-on-surface"
              }`}
            >
              {block.title}
            </span>
          )}

          {/* Indicators */}
          {block.locked && (
            <Lock size={12} className="text-on-surface-muted flex-shrink-0" />
          )}
          {block.recurrenceRule && (
            <Repeat size={12} className="text-on-surface-muted flex-shrink-0" />
          )}
        </div>

        {/* Time range + duration (non-compact only) */}
        {!isCompact && (
          <div className="text-xs text-on-surface-secondary mt-0.5 truncate">
            {formatTimeRange(block.startTime, block.endTime)} · {formatDuration(block.startTime, block.endTime)}
          </div>
        )}
      </div>

      {/* Bottom resize handle */}
      <div
        className="absolute bottom-0 left-0 right-0 h-1 cursor-ns-resize z-20 hover:bg-accent/30 rounded-b-md"
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(block.id, "bottom");
        }}
      />
    </div>
  );
}
