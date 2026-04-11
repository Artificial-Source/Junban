import { useCallback, useEffect } from "react";
import type { Task } from "../../../../core/types.js";
import type { TimeBlock, TimeSlot } from "../types.js";
import type { TimeBlockStore } from "../store.js";
import type TimeblockingPlugin from "../index.js";
import type { ViewMode } from "../utils/timeblocking-utils.js";
import { formatDateStr } from "../components/TimelineColumn.js";

export interface UseTimeblockingDataParams {
  store: TimeBlockStore;
  plugin: TimeblockingPlugin;
  selectedDate: Date;
  dayCount: ViewMode;
  rangeStart: string;
  rangeEnd: string;
  setBlocks: React.Dispatch<React.SetStateAction<TimeBlock[]>>;
  setSlotsState: React.Dispatch<React.SetStateAction<TimeSlot[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
}

export interface UseTimeblockingDataReturn {
  refreshData: () => void;
  refreshTasks: () => Promise<void>;
}

function reuseIfSameById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i]?.id !== next[i]?.id) return next;
  }
  return prev;
}

export function useTimeblockingData(params: UseTimeblockingDataParams): UseTimeblockingDataReturn {
  const { store, plugin, selectedDate, dayCount, rangeStart, rangeEnd, setBlocks, setSlotsState, setTasks } = params;

  const refreshData = useCallback(() => {
    if (dayCount === 1) {
      const dateStr = formatDateStr(selectedDate);
      setBlocks((prev) => reuseIfSameById(prev, store.listBlocks(dateStr)));
      setSlotsState((prev) => reuseIfSameById(prev, store.listSlots(dateStr)));
    } else {
      setBlocks((prev) => reuseIfSameById(prev, store.listBlocksInRange(rangeStart, rangeEnd)));
      setSlotsState((prev) => reuseIfSameById(prev, store.listSlotsInRange(rangeStart, rangeEnd)));
    }
  }, [store, selectedDate, dayCount, rangeStart, rangeEnd, setBlocks, setSlotsState]);

  const refreshTasks = useCallback(async () => {
    const list = await plugin.app.tasks.list?.();
    if (list) {
      setTasks((prev) => reuseIfSameById(prev, list));
    }
  }, [plugin.app.tasks, setTasks]);

  useEffect(() => {
    refreshData();
    refreshTasks();
  }, [refreshData, refreshTasks]);

  return { refreshData, refreshTasks };
}
