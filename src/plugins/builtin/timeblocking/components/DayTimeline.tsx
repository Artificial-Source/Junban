import { useRef } from "react";
import type { TimeBlock, TimeSlot } from "../types.js";
import {
  TimelineColumn,
  timeToMinutes,
  formatHour,
  formatDateStr,
} from "./TimelineColumn.js";

interface DayTimelineProps {
  date: Date;
  blocks: TimeBlock[];
  slots: TimeSlot[];
  workDayStart: string;
  workDayEnd: string;
  gridInterval: number;
  pixelsPerHour?: number;
  taskStatuses?: Map<string, "pending" | "completed" | "cancelled">;
  editingBlockId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onEditingConfirm: () => void;
  onEditingCancel: () => void;
  onBlockCreate: (date: string, startTime: string, endTime: string) => void;
  onBlockMove: (blockId: string, newDate: string, newStartTime: string) => void;
  onBlockResize: (blockId: string, newStartTime: string, newEndTime: string) => void;
  onBlockClick: (blockId: string) => void;
  onSlotClick: (slotId: string) => void;
  onSlotCreate?: (date: string, startTime: string, endTime: string) => void;
  renderSlot?: (slot: TimeSlot) => React.ReactNode;
  /** Hide the date header (when parent already shows it). */
  showHeader?: boolean;
}

function formatDateHeader(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function DayTimeline({
  date,
  blocks,
  slots,
  workDayStart,
  workDayEnd,
  gridInterval,
  pixelsPerHour = 80,
  taskStatuses,
  editingBlockId,
  editingTitle,
  onEditingTitleChange,
  onEditingConfirm,
  onEditingCancel,
  onBlockCreate,
  onBlockMove: _onBlockMove,
  onBlockResize,
  onBlockClick,
  onSlotClick,
  onSlotCreate,
  renderSlot,
  showHeader = true,
}: DayTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const startMinutes = timeToMinutes(workDayStart);
  const endMinutes = timeToMinutes(workDayEnd);
  const totalHours = (endMinutes - startMinutes) / 60;
  const totalHeight = totalHours * pixelsPerHour;
  const pixelsPerMinute = pixelsPerHour / 60;

  const dateStr = formatDateStr(date);

  // Build hour labels
  const hourLabels: Array<{ hour: number; top: number }> = [];
  const startHour = Math.floor(startMinutes / 60);
  const endHour = Math.ceil(endMinutes / 60);
  for (let h = startHour; h < endHour; h++) {
    hourLabels.push({
      hour: h,
      top: (h * 60 - startMinutes) * pixelsPerMinute,
    });
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Date header */}
      {showHeader && (
        <div className="px-4 py-3 border-b border-border bg-surface">
          <h2 className="text-lg font-semibold text-on-surface">
            {formatDateHeader(date)}
          </h2>
        </div>
      )}

      {/* Timeline grid */}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div
          className="relative flex"
          style={{ height: totalHeight }}
        >
          {/* Hour labels column */}
          <div className="w-16 flex-shrink-0 relative" aria-hidden="true">
            {hourLabels.map(({ hour, top }) => (
              <div
                key={hour}
                className="absolute right-2 text-xs text-on-surface-muted -translate-y-1/2"
                style={{ top }}
              >
                {formatHour(hour)}
              </div>
            ))}
          </div>

          {/* Single column grid */}
          <TimelineColumn
            date={date}
            dateStr={dateStr}
            blocks={blocks}
            slots={slots}
            workDayStart={workDayStart}
            workDayEnd={workDayEnd}
            gridInterval={gridInterval}
            pixelsPerHour={pixelsPerHour}
            taskStatuses={taskStatuses}
            editingBlockId={editingBlockId}
            editingTitle={editingTitle}
            onEditingTitleChange={onEditingTitleChange}
            onEditingConfirm={onEditingConfirm}
            onEditingCancel={onEditingCancel}
            onBlockCreate={onBlockCreate}
            onBlockResize={onBlockResize}
            onBlockClick={onBlockClick}
            onSlotClick={onSlotClick}
            onSlotCreate={onSlotCreate}
            renderSlot={renderSlot}
          />
        </div>
      </div>
    </div>
  );
}
