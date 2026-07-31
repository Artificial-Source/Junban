/**
 * Day/Week civil-time grid with current-time line, block/slot cards,
 * pointer create/move/resize, and drop targets for sidebar tasks.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectDto, TaskDto, TimeBlockDto, TimeSlotDto } from "../../api/client";
import { todayKey } from "../../lib/dates";
import { TimeBlockCard } from "./TimeBlockCard";
import { TimeSlotCard } from "./TimeSlotCard";
import {
  buildHourMarks,
  civilDatesInRange,
  civilTimeToMinutes,
  clampCivilRange,
  DEFAULT_BLOCK_DURATION_MINUTES,
  DEFAULT_GRID_INTERVAL_MINUTES,
  formatHourLabel,
  minutesToCivilTime,
  offsetMinutesFromPointer,
  pixelsPerHourForMode,
  type TimeblockingMode,
} from "./timeblockingRange";

function parseCivilDateSafeLocal(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

interface TimelineGridProps {
  mode: TimeblockingMode;
  rangeFrom: string;
  rangeTo: string;
  blocks: TimeBlockDto[];
  slots: TimeSlotDto[];
  tasksById: Map<string, TaskDto>;
  projectsById: Map<string, ProjectDto>;
  workDayStart: string;
  workDayEnd: string;
  gridInterval?: number;
  defaultDuration?: number;
  selectedKey: string | null;
  mutationPending?: boolean;
  onSelect: (occurrenceKey: string | null) => void;
  onOpenBlockEditor: (occurrenceKey: string) => void;
  onOpenSlotEditor: (occurrenceKey: string) => void;
  onCreateBlock: (date: string, start: string, end: string, taskId?: string | null) => void;
  onMoveBlock: (ownerId: string, date: string, start: string, end: string) => void;
  onResizeBlock: (ownerId: string, date: string, start: string, end: string) => void;
  onResizeSlot: (ownerId: string, date: string, start: string, end: string) => void;
  onToggleTask: (taskId: string) => void;
  onRemoveSlotTask: (slotOwnerId: string, taskId: string) => void;
  onReorderSlotTask: (slotOwnerId: string, taskId: string, direction: -1 | 1) => void;
  onAppendSlotTask: (slotOwnerId: string, taskId: string) => void;
}

type DragState =
  | {
      type: "create";
      date: string;
      originMinutes: number;
      currentMinutes: number;
    }
  | {
      type: "move-block";
      occurrenceKey: string;
      ownerId: string;
      date: string;
      duration: number;
      originClientY: number;
      originStart: number;
      currentStart: number;
      columnTop: number;
    }
  | {
      type: "resize-block" | "resize-slot";
      occurrenceKey: string;
      ownerId: string;
      date: string;
      edge: "start" | "end";
      originClientY: number;
      originStart: number;
      originEnd: number;
      currentStart: number;
      currentEnd: number;
      columnTop: number;
    };

const DEFAULT_BLOCK_COLOR = "#6366f1";
const DEFAULT_SLOT_COLOR = "#ec4899";

export function TimelineGrid({
  mode,
  rangeFrom,
  rangeTo,
  blocks,
  slots,
  tasksById,
  projectsById,
  workDayStart,
  workDayEnd,
  gridInterval = DEFAULT_GRID_INTERVAL_MINUTES,
  defaultDuration = DEFAULT_BLOCK_DURATION_MINUTES,
  selectedKey,
  mutationPending = false,
  onSelect,
  onOpenBlockEditor,
  onOpenSlotEditor,
  onCreateBlock,
  onMoveBlock,
  onResizeBlock,
  onResizeSlot,
  onToggleTask,
  onRemoveSlotTask,
  onReorderSlotTask,
  onAppendSlotTask,
}: TimelineGridProps) {
  const workStart = civilTimeToMinutes(workDayStart) ?? 9 * 60;
  const workEnd = civilTimeToMinutes(workDayEnd) ?? 17 * 60;
  const pxPerHour = pixelsPerHourForMode(mode);
  const totalHeight = ((workEnd - workStart) / 60) * pxPerHour;
  const dates = useMemo(() => civilDatesInRange(rangeFrom, rangeTo), [rangeFrom, rangeTo]);
  const hourMarks = useMemo(
    () => buildHourMarks(workStart, workEnd, pxPerHour),
    [workStart, workEnd, pxPerHour],
  );
  const [nowOffset, setNowOffset] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const today = todayKey();

  useEffect(() => {
    const update = () => {
      const now = new Date();
      if (todayKey(now) !== today) {
        setNowOffset(null);
        return;
      }
      if (!dates.includes(today)) {
        setNowOffset(null);
        return;
      }
      const minutes = now.getHours() * 60 + now.getMinutes();
      if (minutes < workStart || minutes > workEnd) {
        setNowOffset(null);
        return;
      }
      setNowOffset(((minutes - workStart) / 60) * pxPerHour);
    };
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [dates, today, workStart, workEnd, pxPerHour]);

  useEffect(() => {
    if (!drag) return;

    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (current.type === "create") {
        const column = document.querySelector<HTMLElement>(
          `[data-timeline-date="${current.date}"]`,
        );
        if (!column) return;
        const rect = column.getBoundingClientRect();
        const minutes = offsetMinutesFromPointer(
          event.clientY,
          rect.top,
          workStart,
          pxPerHour,
          gridInterval,
        );
        setDrag({ ...current, currentMinutes: minutes });
        return;
      }

      const deltaMinutes = ((event.clientY - current.originClientY) / pxPerHour) * 60;
      if (current.type === "move-block") {
        const nextStart = current.originStart + deltaMinutes;
        const clamped = clampCivilRange(
          nextStart,
          nextStart + current.duration,
          workStart,
          workEnd,
          { minDuration: current.duration, gridInterval },
        );
        setDrag({ ...current, currentStart: clamped.start });
        return;
      }

      if (current.edge === "start") {
        const nextStart = current.originStart + deltaMinutes;
        const clamped = clampCivilRange(nextStart, current.originEnd, workStart, workEnd, {
          gridInterval,
        });
        setDrag({ ...current, currentStart: clamped.start, currentEnd: clamped.end });
      } else {
        const nextEnd = current.originEnd + deltaMinutes;
        const clamped = clampCivilRange(current.originStart, nextEnd, workStart, workEnd, {
          gridInterval,
        });
        setDrag({ ...current, currentStart: clamped.start, currentEnd: clamped.end });
      }
    };

    const onUp = () => {
      const current = dragRef.current;
      setDrag(null);
      if (!current) return;
      if (current.type === "create") {
        const lo = Math.min(current.originMinutes, current.currentMinutes);
        const hi = Math.max(current.originMinutes, current.currentMinutes);
        const end = hi === lo ? lo + defaultDuration : hi;
        const clamped = clampCivilRange(lo, end, workStart, workEnd, { gridInterval });
        onCreateBlock(
          current.date,
          minutesToCivilTime(clamped.start),
          minutesToCivilTime(clamped.end),
        );
        return;
      }
      if (current.type === "move-block") {
        const end = current.currentStart + current.duration;
        onMoveBlock(
          current.ownerId,
          current.date,
          minutesToCivilTime(current.currentStart),
          minutesToCivilTime(end),
        );
        return;
      }
      const start = minutesToCivilTime(current.currentStart);
      const end = minutesToCivilTime(current.currentEnd);
      if (current.type === "resize-block") {
        onResizeBlock(current.ownerId, current.date, start, end);
      } else {
        onResizeSlot(current.ownerId, current.date, start, end);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [
    drag,
    workStart,
    workEnd,
    pxPerHour,
    gridInterval,
    defaultDuration,
    onCreateBlock,
    onMoveBlock,
    onResizeBlock,
    onResizeSlot,
  ]);

  const blockColor = (block: TimeBlockDto): string => {
    if (block.color) return block.color;
    if (block.task_id) {
      const task = tasksById.get(block.task_id);
      if (task?.project_id) {
        const project = projectsById.get(task.project_id);
        if (project?.color) return project.color;
      }
    }
    return DEFAULT_BLOCK_COLOR;
  };

  const slotColor = (slot: TimeSlotDto): string => {
    if (slot.color) return slot.color;
    if (slot.project_id) {
      const project = projectsById.get(slot.project_id);
      if (project?.color) return project.color;
    }
    return DEFAULT_SLOT_COLOR;
  };

  const previewFor = (occurrenceKey: string) => {
    if (!drag) return null;
    if (drag.type === "move-block" && drag.occurrenceKey === occurrenceKey) {
      return {
        start: minutesToCivilTime(drag.currentStart),
        end: minutesToCivilTime(drag.currentStart + drag.duration),
      };
    }
    if (
      (drag.type === "resize-block" || drag.type === "resize-slot") &&
      drag.occurrenceKey === occurrenceKey
    ) {
      return {
        start: minutesToCivilTime(drag.currentStart),
        end: minutesToCivilTime(drag.currentEnd),
      };
    }
    return null;
  };

  return (
    <div
      className="relative top-px mr-6 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="timeblocking-timeline"
      data-mode={mode}
    >
      {mode === "week" && (
        <div className="flex shrink-0 overflow-x-auto border-b border-border bg-surface">
          <div className="w-10 shrink-0 sm:w-14" />
          {dates.map((date) => {
            const local = parseCivilDateSafeLocal(date);
            const isToday = date === today;
            const weekend = local ? local.getDay() === 0 || local.getDay() === 6 : false;
            const label = local
              ? local.toLocaleDateString("en-US", { weekday: "short", day: "numeric" })
              : date;
            return (
              <div
                key={date}
                data-testid={`column-header-${date}`}
                className={`min-w-[80px] flex-1 border-l border-border px-1 py-2 text-center text-xs font-medium sm:min-w-[120px] sm:text-sm ${
                  isToday
                    ? "bg-accent-action/10 text-accent-foreground"
                    : weekend
                      ? "text-on-surface-muted opacity-60"
                      : "text-on-surface"
                }`}
              >
                {label}
              </div>
            );
          })}
        </div>
      )}

      <div
        className={`min-h-0 flex-1 ${mode === "week" ? "overflow-auto touch-pan-x touch-pan-y" : "overflow-y-auto overflow-x-hidden"}`}
      >
        <div
          className="relative flex"
          style={{
            height: totalHeight,
            minWidth: mode === "week" ? `${dates.length * 80 + 40}px` : undefined,
          }}
        >
          <div
            className={`relative w-10 shrink-0 ${mode === "week" ? "sm:w-14" : "sm:w-16"}`}
            aria-hidden="true"
          >
            {hourMarks.map(({ hour, top }) => (
              <div
                key={hour}
                className="absolute right-1 -translate-y-1/2 text-[10px] text-on-surface-muted sm:right-2 sm:text-xs"
                style={{ top }}
              >
                {formatHourLabel(hour)}
              </div>
            ))}
          </div>

          {dates.map((date) => {
            const dayBlocks = blocks.filter((block) => block.date === date);
            const daySlots = slots.filter((slot) => slot.date === date);
            return (
              <div
                key={date}
                data-timeline-date={date}
                data-testid={`timeline-column-${date}`}
                className="relative min-w-[80px] flex-1 border-l border-border sm:min-w-[120px]"
                style={{ height: totalHeight }}
                onPointerDown={(event) => {
                  if (mutationPending) return;
                  if ((event.target as HTMLElement).closest("[data-occurrence-key]")) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const minutes = offsetMinutesFromPointer(
                    event.clientY,
                    rect.top,
                    workStart,
                    pxPerHour,
                    gridInterval,
                  );
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setDrag({
                    type: "create",
                    date,
                    originMinutes: minutes,
                    currentMinutes: minutes,
                  });
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
                  const rect = event.currentTarget.getBoundingClientRect();
                  const startMin = offsetMinutesFromPointer(
                    event.clientY,
                    rect.top,
                    workStart,
                    pxPerHour,
                    gridInterval,
                  );
                  const task = tasksById.get(taskId);
                  const duration = task?.estimated_minutes ?? defaultDuration;
                  const clamped = clampCivilRange(
                    startMin,
                    startMin + duration,
                    workStart,
                    workEnd,
                    {
                      gridInterval,
                      minDuration: Math.min(duration, DEFAULT_BLOCK_DURATION_MINUTES),
                    },
                  );
                  onCreateBlock(
                    date,
                    minutesToCivilTime(clamped.start),
                    minutesToCivilTime(clamped.end),
                    taskId,
                  );
                }}
              >
                {Array.from(
                  { length: Math.ceil((workEnd - workStart) / gridInterval) },
                  (_, index) => {
                    const minutes = workStart + index * gridInterval;
                    const isHour = minutes % 60 === 0;
                    return (
                      <div
                        key={minutes}
                        className={`border-b ${isHour ? "border-border" : "border-border/30"}`}
                        style={{ height: (gridInterval / 60) * pxPerHour }}
                      />
                    );
                  },
                )}

                {daySlots.map((slot) => {
                  const preview = previewFor(slot.occurrence_key);
                  const display = preview ? { ...slot, ...preview } : slot;
                  return (
                    <TimeSlotCard
                      key={slot.occurrence_key}
                      slot={display}
                      tasksById={tasksById}
                      pixelsPerHour={pxPerHour}
                      workDayStart={workDayStart}
                      color={slotColor(slot)}
                      selected={selectedKey === slot.occurrence_key}
                      mutationPending={mutationPending}
                      onSelect={onSelect}
                      onOpenEditor={onOpenSlotEditor}
                      onToggleTask={onToggleTask}
                      onRemoveTask={onRemoveSlotTask}
                      onMoveTask={onReorderSlotTask}
                      onDropTask={onAppendSlotTask}
                      onResizePointerDown={(occurrenceKey, edge, event) => {
                        if (mutationPending) return;
                        event.preventDefault();
                        const start = civilTimeToMinutes(slot.start) ?? workStart;
                        const end = civilTimeToMinutes(slot.end) ?? start + 60;
                        const column = event.currentTarget.closest(
                          "[data-timeline-date]",
                        ) as HTMLElement | null;
                        setDrag({
                          type: "resize-slot",
                          occurrenceKey,
                          ownerId: slot.id,
                          date: slot.date,
                          edge,
                          originClientY: event.clientY,
                          originStart: start,
                          originEnd: end,
                          currentStart: start,
                          currentEnd: end,
                          columnTop: column?.getBoundingClientRect().top ?? 0,
                        });
                      }}
                    />
                  );
                })}

                {dayBlocks.map((block) => {
                  const preview = previewFor(block.occurrence_key);
                  const display = preview ? { ...block, ...preview } : block;
                  const task = block.task_id ? tasksById.get(block.task_id) : undefined;
                  return (
                    <TimeBlockCard
                      key={block.occurrence_key}
                      block={display}
                      pixelsPerHour={pxPerHour}
                      workDayStart={workDayStart}
                      color={blockColor(block)}
                      taskStatus={task?.status}
                      selected={selectedKey === block.occurrence_key}
                      onSelect={onSelect}
                      onOpenEditor={onOpenBlockEditor}
                      onResizePointerDown={(occurrenceKey, edge, event) => {
                        if (mutationPending) return;
                        event.preventDefault();
                        const start = civilTimeToMinutes(block.start) ?? workStart;
                        const end = civilTimeToMinutes(block.end) ?? start + 30;
                        const column = event.currentTarget.closest(
                          "[data-timeline-date]",
                        ) as HTMLElement | null;
                        setDrag({
                          type: "resize-block",
                          occurrenceKey,
                          ownerId: block.id,
                          date: block.date,
                          edge,
                          originClientY: event.clientY,
                          originStart: start,
                          originEnd: end,
                          currentStart: start,
                          currentEnd: end,
                          columnTop: column?.getBoundingClientRect().top ?? 0,
                        });
                      }}
                      onMovePointerDown={(occurrenceKey, event) => {
                        if (mutationPending) return;
                        if (event.button !== 0) return;
                        event.preventDefault();
                        const start = civilTimeToMinutes(block.start) ?? workStart;
                        const end = civilTimeToMinutes(block.end) ?? start + 30;
                        const column = event.currentTarget.closest(
                          "[data-timeline-date]",
                        ) as HTMLElement | null;
                        setDrag({
                          type: "move-block",
                          occurrenceKey,
                          ownerId: block.id,
                          date: block.date,
                          duration: end - start,
                          originClientY: event.clientY,
                          originStart: start,
                          currentStart: start,
                          columnTop: column?.getBoundingClientRect().top ?? 0,
                        });
                      }}
                    />
                  );
                })}

                {drag?.type === "create" && drag.date === date && (
                  <div
                    className="pointer-events-none absolute left-1 right-1 z-30 rounded-md border border-dashed border-accent-action bg-accent-action/15"
                    style={{
                      top:
                        ((Math.min(drag.originMinutes, drag.currentMinutes) - workStart) / 60) *
                        pxPerHour,
                      height: Math.max(
                        (Math.max(
                          Math.abs(drag.currentMinutes - drag.originMinutes),
                          defaultDuration,
                        ) /
                          60) *
                          pxPerHour,
                        16,
                      ),
                    }}
                    data-testid="create-preview"
                  />
                )}

                {nowOffset !== null && date === today && (
                  <div
                    className="pointer-events-none absolute left-0 right-0 z-20 flex items-center"
                    style={{ top: nowOffset }}
                    data-testid="current-time-indicator"
                  >
                    <div className="h-2.5 w-2.5 flex-shrink-0 -ml-1.5 rounded-full bg-error" />
                    <div className="h-0.5 flex-1 bg-error" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
