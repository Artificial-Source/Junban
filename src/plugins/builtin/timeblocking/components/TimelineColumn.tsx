import { useEffect, useRef, useState, useCallback } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { TimeBlock, TimeSlot } from "../types.js";
import { TimeBlockCard } from "./TimeBlockCard.js";
import { findConflicts } from "../slot-helpers.js";

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

export function snapToGrid(minutes: number, gridInterval: number): number {
  return Math.round(minutes / gridInterval) * gridInterval;
}

export function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface TimelineColumnProps {
  date: Date;
  dateStr: string;
  blocks: TimeBlock[];
  slots: TimeSlot[];
  workDayStart: string;
  workDayEnd: string;
  gridInterval: number;
  pixelsPerHour: number;
  taskStatuses?: Map<string, "pending" | "completed" | "cancelled">;
  editingBlockId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onEditingConfirm: () => void;
  onEditingCancel: () => void;
  onBlockCreate: (date: string, startTime: string, endTime: string) => void;
  onBlockResize: (blockId: string, newStartTime: string, newEndTime: string) => void;
  onBlockClick: (blockId: string) => void;
  onSlotClick?: (slotId: string) => void;
  /** Slot creation handler (Shift+Alt+Click). */
  onSlotCreate?: (date: string, startTime: string, endTime: string) => void;
  /** Render function for slots on this column. */
  renderSlot?: (slot: TimeSlot) => React.ReactNode;
}

/** A single drop-target cell on the timeline grid. */
function GridCell({
  dateStr,
  time,
  height,
  isHourBoundary,
}: {
  dateStr: string;
  time: string;
  height: number;
  isHourBoundary: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `grid-${dateStr}-${time}`,
    data: { type: "timeline-slot", date: dateStr, time },
  });

  return (
    <div
      ref={setNodeRef}
      data-time={time}
      data-date={dateStr}
      className={`border-b ${isHourBoundary ? "border-border" : "border-border/30"} ${
        isOver ? "bg-accent/10" : ""
      }`}
      style={{ height }}
    />
  );
}

/** A single column of the hour grid with blocks and drop targets. */
export function TimelineColumn({
  date,
  dateStr,
  blocks,
  slots,
  workDayStart,
  workDayEnd,
  gridInterval,
  pixelsPerHour,
  taskStatuses,
  editingBlockId,
  editingTitle,
  onEditingTitleChange,
  onEditingConfirm,
  onEditingCancel,
  onBlockCreate,
  onBlockResize,
  onBlockClick,
  onSlotCreate,
  renderSlot,
}: TimelineColumnProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentTimeOffset, setCurrentTimeOffset] = useState<number | null>(null);
  const [resizePreview, setResizePreview] = useState<{
    blockId: string;
    startTime: string;
    endTime: string;
  } | null>(null);

  const startMinutes = timeToMinutes(workDayStart);
  const endMinutes = timeToMinutes(workDayEnd);
  const totalHours = (endMinutes - startMinutes) / 60;
  const totalHeight = totalHours * pixelsPerHour;
  const pixelsPerMinute = pixelsPerHour / 60;
  const slotHeight = (gridInterval / 60) * pixelsPerHour;

  // Current time indicator
  useEffect(() => {
    if (!isToday(date)) {
      setCurrentTimeOffset(null);
      return;
    }

    const update = () => {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (nowMinutes >= startMinutes && nowMinutes <= endMinutes) {
        setCurrentTimeOffset((nowMinutes - startMinutes) * pixelsPerMinute);
      } else {
        setCurrentTimeOffset(null);
      }
    };

    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, [date, startMinutes, endMinutes, pixelsPerMinute]);

  // Build grid slots
  const gridSlots: Array<{ time: string; isHourBoundary: boolean }> = [];
  for (let m = startMinutes; m < endMinutes; m += gridInterval) {
    gridSlots.push({
      time: minutesToTime(m),
      isHourBoundary: m % 60 === 0,
    });
  }

  // Conflict detection
  const conflicts = findConflicts(blocks, slots, dateStr);
  const conflictingBlockIds = new Set<string>();
  const conflictTooltips = new Map<string, string>();
  for (const c of conflicts) {
    if (c.a.type === "block") conflictingBlockIds.add(c.a.id);
    if (c.b.type === "block") conflictingBlockIds.add(c.b.id);
    // Build tooltip text
    const aItem = [...blocks, ...slots].find((x) => x.id === c.a.id);
    const bItem = [...blocks, ...slots].find((x) => x.id === c.b.id);
    if (aItem && bItem) {
      const aTitle = "title" in aItem ? aItem.title : c.a.id;
      const bTitle = "title" in bItem ? bItem.title : c.b.id;
      if (c.a.type === "block") {
        conflictTooltips.set(c.a.id, `Overlaps with ${bTitle} (${bItem.startTime}–${bItem.endTime})`);
      }
      if (c.b.type === "block") {
        conflictTooltips.set(c.b.id, `Overlaps with ${aTitle} (${aItem.startTime}–${aItem.endTime})`);
      }
    }
  }

  // Resize handler
  const handleResizeStart = useCallback(
    (blockId: string, edge: "top" | "bottom") => {
      const block = blocks.find((b) => b.id === blockId);
      if (!block) return;

      const onPointerMove = (e: PointerEvent) => {
        const currentResizing = {
          blockId,
          edge,
          startY: e.clientY,
          originalStart: block.startTime,
          originalEnd: block.endTime,
        };

        const deltaY = e.clientY - currentResizing.startY;
        const deltaMinutes = snapToGrid(
          (deltaY / pixelsPerHour) * 60,
          gridInterval,
        );

        let newStart = block.startTime;
        let newEnd = block.endTime;

        if (edge === "top") {
          const newStartMinutes = Math.max(
            startMinutes,
            timeToMinutes(block.startTime) + deltaMinutes,
          );
          if (timeToMinutes(block.endTime) - newStartMinutes >= 15) {
            newStart = minutesToTime(newStartMinutes);
          }
        } else {
          const newEndMinutes = Math.min(
            endMinutes,
            timeToMinutes(block.endTime) + deltaMinutes,
          );
          if (newEndMinutes - timeToMinutes(block.startTime) >= 15) {
            newEnd = minutesToTime(newEndMinutes);
          }
        }

        setResizePreview({ blockId, startTime: newStart, endTime: newEnd });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);

        setResizePreview((prev) => {
          if (prev && prev.blockId === blockId) {
            onBlockResize(blockId, prev.startTime, prev.endTime);
          }
          return null;
        });
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [blocks, gridInterval, pixelsPerHour, startMinutes, endMinutes, onBlockResize],
  );

  // Alt+Click to create block, Shift+Alt+Click to create slot
  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!e.altKey) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = snapToGrid(startMinutes + y / pixelsPerMinute, gridInterval);
      const startTime = minutesToTime(Math.max(startMinutes, Math.min(minutes, endMinutes - gridInterval)));
      const endTime = minutesToTime(Math.min(timeToMinutes(startTime) + (e.shiftKey ? 120 : 30), endMinutes));

      if (e.shiftKey && onSlotCreate) {
        onSlotCreate(dateStr, startTime, endTime);
      } else {
        onBlockCreate(dateStr, startTime, endTime);
      }
    },
    [startMinutes, endMinutes, pixelsPerMinute, gridInterval, dateStr, onBlockCreate, onSlotCreate],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("[data-block-id]")) return;
      if ((e.target as HTMLElement).closest("[data-slot-id]")) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = snapToGrid(startMinutes + y / pixelsPerMinute, gridInterval);
      const startTime = minutesToTime(Math.max(startMinutes, Math.min(minutes, endMinutes - gridInterval)));
      const endTime = minutesToTime(Math.min(timeToMinutes(startTime) + 30, endMinutes));
      onBlockCreate(dateStr, startTime, endTime);
    },
    [startMinutes, endMinutes, pixelsPerMinute, gridInterval, dateStr, onBlockCreate],
  );

  // Filter blocks and slots for this column's date
  const dayBlocks = blocks.filter((b) => b.date === dateStr);
  const daySlots = slots.filter((s) => s.date === dateStr);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative border-l border-border min-w-[120px]"
      style={{ height: totalHeight }}
      onClick={handleTimelineClick}
      onDoubleClick={handleDoubleClick}
      data-testid={`timeline-column-${dateStr}`}
    >
      {/* Grid lines / drop cells */}
      {gridSlots.map((slot) => (
        <GridCell
          key={`${dateStr}-${slot.time}`}
          dateStr={dateStr}
          time={slot.time}
          height={slotHeight}
          isHourBoundary={slot.isHourBoundary}
        />
      ))}

      {/* Time blocks */}
      {dayBlocks.map((block) => {
        const preview =
          resizePreview?.blockId === block.id ? resizePreview : null;
        const displayBlock = preview
          ? { ...block, startTime: preview.startTime, endTime: preview.endTime }
          : block;

        return (
          <TimeBlockCard
            key={block.id}
            block={displayBlock}
            pixelsPerHour={pixelsPerHour}
            workDayStart={workDayStart}
            isConflicting={conflictingBlockIds.has(block.id)}
            conflictTooltip={conflictTooltips.get(block.id)}
            taskStatus={
              block.taskId ? taskStatuses?.get(block.taskId) : undefined
            }
            isEditing={editingBlockId === block.id}
            editingTitle={editingTitle}
            onEditingTitleChange={onEditingTitleChange}
            onEditingConfirm={onEditingConfirm}
            onEditingCancel={onEditingCancel}
            onResizeStart={handleResizeStart}
            onClick={onBlockClick}
          />
        );
      })}

      {/* Time slots */}
      {daySlots.map((slot) => renderSlot?.(slot))}

      {/* Current time indicator */}
      {currentTimeOffset !== null && (
        <div
          className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
          style={{ top: currentTimeOffset }}
          data-testid="current-time-indicator"
        >
          <div className="w-2.5 h-2.5 rounded-full bg-error -ml-1.5 flex-shrink-0" />
          <div className="flex-1 h-0.5 bg-error" />
        </div>
      )}
    </div>
  );
}
