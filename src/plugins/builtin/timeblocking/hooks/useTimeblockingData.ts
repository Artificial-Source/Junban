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

export function useTimeblockingData(params: UseTimeblockingDataParams): UseTimeblockingDataReturn {
  const { store, plugin, selectedDate, dayCount, rangeStart, rangeEnd, setBlocks, setSlotsState, setTasks } = params;

  const refreshData = useCallback(() => {
    if (dayCount === 1) {
      const dateStr = formatDateStr(selectedDate);
      setBlocks(store.listBlocks(dateStr));
      setSlotsState(store.listSlots(dateStr));
    } else {
      setBlocks(store.listBlocksInRange(rangeStart, rangeEnd));
      setSlotsState(store.listSlotsInRange(rangeStart, rangeEnd));
    }
  }, [store, selectedDate, dayCount, rangeStart, rangeEnd, setBlocks, setSlotsState]);

  const refreshTasks = useCallback(async () => {
    const list = await plugin.app.tasks.list?.();
    if (list) setTasks(list);
  }, [plugin.app.tasks, setTasks]);

  useEffect(() => {
    refreshData();
    refreshTasks();
  }, [refreshData, refreshTasks]);

  return { refreshData, refreshTasks };
}
