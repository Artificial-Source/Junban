import { useRef, useMemo } from "react";
import type { TimeBlock, TimeSlot } from "../types.js";
import {
  TimelineColumn,
  timeToMinutes,
  formatHour,
  formatDateStr,
  isToday,
} from "./TimelineColumn.js";

interface WeekTimelineProps {
  startDate: Date;
  dayCount: number;
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
}

function formatColumnHeader(date: Date): string {
  const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
  return `${dayName} ${date.getDate()}`;
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function WeekTimeline({
  startDate,
  dayCount,
  blocks,
  slots,
  workDayStart,
  workDayEnd,
  gridInterval,
  pixelsPerHour = 64,
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
}: WeekTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const startMinutes = timeToMinutes(workDayStart);
  const endMinutes = timeToMinutes(workDayEnd);
  const totalHours = (endMinutes - startMinutes) / 60;
  const totalHeight = totalHours * pixelsPerHour;
  const pixelsPerMinute = pixelsPerHour / 60;

  // Build column dates
  const columns = useMemo(() => {
    const cols: Array<{ date: Date; dateStr: string }> = [];
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      cols.push({ date: d, dateStr: formatDateStr(d) });
    }
    return cols;
  }, [startDate, dayCount]);

  // Build hour labels
  const hourLabels = useMemo(() => {
    const labels: Array<{ hour: number; top: number }> = [];
    const startHour = Math.floor(startMinutes / 60);
    const endHour = Math.ceil(endMinutes / 60);
    for (let h = startHour; h < endHour; h++) {
      labels.push({
        hour: h,
        top: (h * 60 - startMinutes) * pixelsPerMinute,
      });
    }
    return labels;
  }, [startMinutes, endMinutes, pixelsPerMinute]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Column headers */}
      <div className="flex border-b border-border bg-surface flex-shrink-0">
        {/* Spacer for hour labels */}
        <div className="w-14 flex-shrink-0" />
        {columns.map(({ date, dateStr }) => {
          const today = isToday(date);
          const weekend = isWeekend(date);
          return (
            <div
              key={dateStr}
              className={`flex-1 min-w-[120px] px-2 py-2 text-center text-sm font-medium border-l border-border ${
                today
                  ? "bg-accent/10 text-accent"
                  : weekend
                    ? "text-on-surface-muted opacity-60"
                    : "text-on-surface"
              }`}
              data-testid={`column-header-${dateStr}`}
            >
              {formatColumnHeader(date)}
            </div>
          );
        })}
      </div>

      {/* Scrollable grid area */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <div className="relative flex" style={{ height: totalHeight, minWidth: `${columns.length * 120 + 56}px` }}>
          {/* Hour labels column */}
          <div className="w-14 flex-shrink-0 relative" aria-hidden="true">
            {hourLabels.map(({ hour, top }) => (
              <div
                key={hour}
                className="absolute right-1 text-xs text-on-surface-muted -translate-y-1/2"
                style={{ top }}
              >
                {formatHour(hour)}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {columns.map(({ date, dateStr }) => (
            <TimelineColumn
              key={dateStr}
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
          ))}
        </div>
      </div>
    </div>
  );
}
