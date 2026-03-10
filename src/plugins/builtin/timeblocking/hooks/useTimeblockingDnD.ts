import { useCallback, useEffect } from "react";
import { arrayMove } from "@dnd-kit/sortable";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { Task } from "../../../../core/types.js";
import type { TimeBlock, TimeSlot } from "../types.js";
import type { TimeBlockStore } from "../store.js";
import { isOverlapping } from "../slot-helpers.js";
import { formatDateStr, timeToMinutes, minutesToTime, snapToGrid } from "../components/TimelineColumn.js";

export interface UseTimeblockingDnDParams {
  store: TimeBlockStore;
  blocks: TimeBlock[];
  tasks: Task[];
  slotsState: TimeSlot[];
  selectedDate: Date;
  activeDragId: string | null;
  activeDragType: "task" | "block" | null;
  defaultDuration: number;
  workDayEnd: string;
  gridInterval: number;
  refreshData: () => void;
  setActiveDragId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveDragType: React.Dispatch<React.SetStateAction<"task" | "block" | null>>;
  setDragConflict: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface UseTimeblockingDnDReturn {
  handleDragStart: (event: DragStartEvent) => void;
  handleDragEnd: (event: DragEndEvent) => Promise<void>;
  handleDragCancel: () => void;
  activeDragTask: Task | null;
  activeDragBlock: TimeBlock | null;
}

export function useTimeblockingDnD(params: UseTimeblockingDnDParams): UseTimeblockingDnDReturn {
  const {
    store, blocks, tasks, slotsState, selectedDate,
    activeDragId, activeDragType,
    defaultDuration, workDayEnd, gridInterval,
    refreshData, setActiveDragId, setActiveDragType, setDragConflict,
  } = params;

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current;
      if (data?.type === "task") {
        setActiveDragId(event.active.id as string);
        setActiveDragType("task");
      } else if (data?.type === "block") {
        setActiveDragId(event.active.id as string);
        setActiveDragType("block");
      }
      setDragConflict(false);
    },
    [setActiveDragId, setActiveDragType, setDragConflict],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragId(null);
      setActiveDragType(null);
      setDragConflict(false);

      if (!over) return;

      const overData = over.data.current;
      const activeData = active.data.current;

      // Task dropped onto a slot
      if (overData?.type === "slot" && activeData?.type === "task") {
        const task = activeData.task as Task;
        const slotId = overData.slotId as string;
        await store.addTaskToSlot(slotId, task.id);
        refreshData();
        return;
      }

      // Task dropped on timeline grid
      if (overData?.type === "timeline-slot" && activeData?.type === "task") {
        const task = activeData.task as Task;
        const dropTime = overData.time as string;
        const dropDate = (overData.date as string) || formatDateStr(selectedDate);
        const duration = task.estimatedMinutes ?? defaultDuration;
        const startMinutes = timeToMinutes(dropTime);
        const endMinutes = Math.min(
          startMinutes + duration,
          timeToMinutes(workDayEnd),
        );
        const endTime = minutesToTime(endMinutes);

        await store.createBlock({
          taskId: task.id,
          title: task.title,
          date: dropDate,
          startTime: dropTime,
          endTime,
          locked: false,
        });
        refreshData();
        return;
      }

      // Block dropped on timeline grid
      if (overData?.type === "timeline-slot" && activeData?.type === "block") {
        const block = activeData.block as TimeBlock;
        const dropTime = overData.time as string;
        const dropDate = (overData.date as string) || formatDateStr(selectedDate);
        const duration = timeToMinutes(block.endTime) - timeToMinutes(block.startTime);
        const newStartMinutes = snapToGrid(timeToMinutes(dropTime), gridInterval);
        const newEndMinutes = Math.min(
          newStartMinutes + duration,
          timeToMinutes(workDayEnd),
        );

        await store.updateBlock(block.id, {
          date: dropDate,
          startTime: minutesToTime(newStartMinutes),
          endTime: minutesToTime(newEndMinutes),
        });
        refreshData();
        return;
      }

      // Reorder within slot (sortable)
      if (activeData?.type === "slot-task" && overData?.type === "slot-task") {
        const activeTaskId = activeData.taskId as string;
        const overTaskId = overData.taskId as string;
        for (const slot of slotsState) {
          const oldIndex = slot.taskIds.indexOf(activeTaskId);
          const newIndex = slot.taskIds.indexOf(overTaskId);
          if (oldIndex !== -1 && newIndex !== -1) {
            const newOrder = arrayMove(slot.taskIds, oldIndex, newIndex);
            await store.reorderSlotTasks(slot.id, newOrder);
            refreshData();
            return;
          }
        }
      }
    },
    [store, selectedDate, defaultDuration, workDayEnd, gridInterval, refreshData, slotsState, setActiveDragId, setActiveDragType, setDragConflict],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setActiveDragType(null);
    setDragConflict(false);
  }, [setActiveDragId, setActiveDragType, setDragConflict]);

  // Resolve active drag item for DragOverlay
  const activeDragTask =
    activeDragType === "task"
      ? tasks.find((t) => t.id === activeDragId) ?? null
      : null;
  const activeDragBlock =
    activeDragType === "block"
      ? blocks.find((b) => b.id === activeDragId) ?? null
      : null;

  // Check if dragged block would conflict
  useEffect(() => {
    if (!activeDragBlock) {
      setDragConflict(false);
      return;
    }
    const others = blocks.filter((b) => b.id !== activeDragBlock.id);
    const hasConflict = others.some((b) =>
      isOverlapping(activeDragBlock.startTime, activeDragBlock.endTime, b.startTime, b.endTime),
    );
    setDragConflict(hasConflict);
  }, [activeDragBlock, blocks, setDragConflict]);

  return {
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
    activeDragTask,
    activeDragBlock,
  };
}
