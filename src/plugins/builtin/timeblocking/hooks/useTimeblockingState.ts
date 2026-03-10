import { useState, useMemo, useRef } from "react";
import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { Task } from "../../../../core/types.js";
import type { TimeBlock, TimeSlot } from "../types.js";
import type { TimeBlockStore } from "../store.js";
import { isTaskScheduled } from "../task-linking.js";
import { formatDateStr } from "../components/TimelineColumn.js";
import { type ViewMode, getDateRangeStrings, findActiveBlock, SIDEBAR_DEFAULT_WIDTH } from "../utils/timeblocking-utils.js";
import type TimeblockingPlugin from "../index.js";

export interface ContextMenuState {
  type: "timeline" | "block" | "slot";
  position: { x: number; y: number };
  targetId?: string;
  date?: string;
  time?: string;
}

export interface TimeblockingState {
  // Core state
  selectedDate: Date;
  setSelectedDate: React.Dispatch<React.SetStateAction<Date>>;
  dayCount: ViewMode;
  setDayCount: React.Dispatch<React.SetStateAction<ViewMode>>;
  blocks: TimeBlock[];
  setBlocks: React.Dispatch<React.SetStateAction<TimeBlock[]>>;
  slotsState: TimeSlot[];
  setSlotsState: React.Dispatch<React.SetStateAction<TimeSlot[]>>;
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;

  // DnD state
  activeDragId: string | null;
  setActiveDragId: React.Dispatch<React.SetStateAction<string | null>>;
  activeDragType: "task" | "block" | null;
  setActiveDragType: React.Dispatch<React.SetStateAction<"task" | "block" | null>>;
  dragConflict: boolean;
  setDragConflict: React.Dispatch<React.SetStateAction<boolean>>;

  // Inline editing
  editingBlockId: string | null;
  setEditingBlockId: React.Dispatch<React.SetStateAction<string | null>>;
  editingTitle: string;
  setEditingTitle: React.Dispatch<React.SetStateAction<string>>;

  // Sidebar
  sidebarCollapsed: boolean;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarWidth: number;
  setSidebarWidth: React.Dispatch<React.SetStateAction<number>>;
  dividerRef: React.RefObject<HTMLDivElement | null>;

  // Selection
  selectedBlockId: string | null;
  setSelectedBlockId: React.Dispatch<React.SetStateAction<string | null>>;

  // Context menu
  contextMenu: ContextMenuState | null;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;

  // Clipboard
  clipboardBlock: TimeBlock | null;
  setClipboardBlock: React.Dispatch<React.SetStateAction<TimeBlock | null>>;

  // Settings
  settingsVersion: number;
  setSettingsVersion: React.Dispatch<React.SetStateAction<number>>;

  // Plugin settings (derived)
  workDayStart: string;
  workDayEnd: string;
  gridIntervalStr: string;
  defaultDurationStr: string;
  gridInterval: number;
  defaultDuration: number;

  // Range
  rangeStart: string;
  rangeEnd: string;

  // Sensors
  sensors: ReturnType<typeof useSensors>;

  // Derived state
  taskStatuses: Map<string, "pending" | "completed" | "cancelled">;
  projects: Array<{ id: string; color: string }>;
  scheduledTaskIds: Set<string>;
  activeBlock: TimeBlock | null;
  sidebarGroups: { overdue: Task[]; today: Task[]; unscheduled: Task[] };
}

export function useTimeblockingState(plugin: TimeblockingPlugin, store: TimeBlockStore): TimeblockingState {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [dayCount, setDayCount] = useState<ViewMode>(1);
  const [blocks, setBlocks] = useState<TimeBlock[]>([]);
  const [slotsState, setSlotsState] = useState<TimeSlot[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragType, setActiveDragType] = useState<"task" | "block" | null>(null);
  const [dragConflict, setDragConflict] = useState(false);

  // Inline editing state
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const dividerRef = useRef<HTMLDivElement>(null);

  // Selected block for keyboard operations
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Clipboard for block copy/paste
  const [clipboardBlock, setClipboardBlock] = useState<TimeBlock | null>(null);

  // Settings version — incremented to force re-render after settings change
  const [settingsVersion, setSettingsVersion] = useState(0);

  // Plugin settings (re-read when settingsVersion changes)
  const workDayStart = plugin.settings.get<string>("workDayStart") ?? "09:00";
  const workDayEnd = plugin.settings.get<string>("workDayEnd") ?? "17:00";
  const gridIntervalStr = plugin.settings.get<string>("gridIntervalMinutes") ?? "30";
  const defaultDurationStr = plugin.settings.get<string>("defaultDurationMinutes") ?? "30";
  const gridInterval = parseInt(gridIntervalStr, 10);
  const defaultDuration = parseInt(defaultDurationStr, 10);
  void settingsVersion; // Ensure re-render dependency

  const { startStr: rangeStart, endStr: rangeEnd } = getDateRangeStrings(selectedDate, dayCount);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Task status map for blocks
  const taskStatuses = useMemo(() => {
    const map = new Map<string, "pending" | "completed" | "cancelled">();
    for (const t of tasks) {
      map.set(t.id, t.status);
    }
    return map;
  }, [tasks]);

  // Project list for slot colors
  const projects = useMemo(() => {
    return tasks.reduce<Array<{ id: string; color: string }>>((acc, t) => {
      if (t.projectId && !acc.some((p) => p.id === t.projectId)) {
        acc.push({ id: t.projectId, color: "#6366f1" });
      }
      return acc;
    }, []);
  }, [tasks]);

  // Scheduled task IDs for the sidebar
  const scheduledTaskIds = useMemo(() => {
    const allBlocks = store.listBlocks();
    const today = formatDateStr(new Date());
    const ids = new Set<string>();
    for (const b of allBlocks) {
      if (b.taskId && isTaskScheduled(allBlocks, b.taskId, today)) {
        ids.add(b.taskId);
      }
    }
    return ids;
  }, [store, blocks]);

  // Active block (for focus timer)
  const activeBlock = useMemo(() => {
    const allBlocks = store.listBlocks();
    return findActiveBlock(allBlocks);
  }, [store, blocks]);

  // Task grouping for sidebar
  const sidebarGroups = useMemo(() => {
    const todayStr = formatDateStr(new Date());
    const pending = tasks.filter((t) => t.status === "pending");
    const overdue: Task[] = [];
    const today: Task[] = [];
    const unscheduled: Task[] = [];

    for (const t of pending) {
      if (t.dueDate && t.dueDate < todayStr) {
        overdue.push(t);
      } else if (t.dueDate === todayStr) {
        today.push(t);
      } else {
        unscheduled.push(t);
      }
    }

    return { overdue, today, unscheduled };
  }, [tasks]);

  return {
    selectedDate, setSelectedDate,
    dayCount, setDayCount,
    blocks, setBlocks,
    slotsState, setSlotsState,
    tasks, setTasks,
    activeDragId, setActiveDragId,
    activeDragType, setActiveDragType,
    dragConflict, setDragConflict,
    editingBlockId, setEditingBlockId,
    editingTitle, setEditingTitle,
    sidebarCollapsed, setSidebarCollapsed,
    sidebarWidth, setSidebarWidth,
    dividerRef,
    selectedBlockId, setSelectedBlockId,
    contextMenu, setContextMenu,
    clipboardBlock, setClipboardBlock,
    settingsVersion, setSettingsVersion,
    workDayStart, workDayEnd,
    gridIntervalStr, defaultDurationStr,
    gridInterval, defaultDuration,
    rangeStart, rangeEnd,
    sensors,
    taskStatuses, projects, scheduledTaskIds, activeBlock, sidebarGroups,
  };
}
