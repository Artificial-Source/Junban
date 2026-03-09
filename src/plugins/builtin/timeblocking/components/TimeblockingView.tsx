import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Task } from "../../../../core/types.js";
import type { TimeBlock, TimeSlot } from "../types.js";
import { isTaskScheduled } from "../task-linking.js";
import { useTimeblocking } from "../context.js";
import { DayTimeline } from "./DayTimeline.js";
import { WeekTimeline } from "./WeekTimeline.js";
import { TaskSidebar } from "./TaskSidebar.js";
import { TimeSlotCard } from "./TimeSlotCard.js";
import { TaskDragPreview, BlockDragPreview } from "./DragPreview.js";
import { ReplanBanner } from "./ReplanBanner.js";
import { SettingsPopover } from "./SettingsPopover.js";
import { FocusTimer } from "./FocusTimer.js";
import { isOverlapping } from "../slot-helpers.js";
import { formatDateStr, timeToMinutes, minutesToTime, snapToGrid } from "./TimelineColumn.js";

type ViewMode = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const VIEW_MODE_LABELS: Array<{ value: ViewMode; label: string }> = [
  { value: 1, label: "Day" },
  { value: 3, label: "3D" },
  { value: 5, label: "5D" },
  { value: 7, label: "Week" },
];

function getPixelsPerHour(dayCount: ViewMode): number {
  if (dayCount === 1) return 80;
  if (dayCount <= 3) return 64;
  if (dayCount <= 5) return 48;
  return 40;
}

function formatDateRange(startDate: Date, dayCount: number): string {
  if (dayCount === 1) {
    return startDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + dayCount - 1);
  const startStr = startDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const endStr = endDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startStr} – ${endStr}`;
}

function getDateRangeStrings(startDate: Date, dayCount: number): { startStr: string; endStr: string } {
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + dayCount - 1);
  return { startStr: formatDateStr(startDate), endStr: formatDateStr(endDate) };
}

/** Find the currently active block (current time falls within its range). */
function findActiveBlock(blocks: TimeBlock[]): TimeBlock | null {
  const now = new Date();
  const todayStr = formatDateStr(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return blocks.find(
    (b) =>
      b.date === todayStr &&
      nowMinutes >= timeToMinutes(b.startTime) &&
      nowMinutes < timeToMinutes(b.endTime),
  ) ?? null;
}

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 400;
const SIDEBAR_DEFAULT_WIDTH = 280;

export function TimeblockingView() {
  const plugin = useTimeblocking();
  const store = plugin.store;

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

  // Load data
  const refreshData = useCallback(() => {
    if (dayCount === 1) {
      const dateStr = formatDateStr(selectedDate);
      setBlocks(store.listBlocks(dateStr));
      setSlotsState(store.listSlots(dateStr));
    } else {
      setBlocks(store.listBlocksInRange(rangeStart, rangeEnd));
      setSlotsState(store.listSlotsInRange(rangeStart, rangeEnd));
    }
  }, [store, selectedDate, dayCount, rangeStart, rangeEnd]);

  const refreshTasks = useCallback(async () => {
    const list = await plugin.app.tasks.list?.();
    if (list) setTasks(list);
  }, [plugin.app.tasks]);

  useEffect(() => {
    refreshData();
    refreshTasks();
  }, [refreshData, refreshTasks]);

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
  }, [store, blocks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Active block (for focus timer)
  const activeBlock = useMemo(() => {
    const allBlocks = store.listBlocks();
    return findActiveBlock(allBlocks);
  }, [store, blocks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Date navigation
  const goToPrevious = useCallback(() => {
    setSelectedDate((d) => {
      const prev = new Date(d);
      prev.setDate(prev.getDate() - dayCount);
      return prev;
    });
  }, [dayCount]);

  const goToNext = useCallback(() => {
    setSelectedDate((d) => {
      const next = new Date(d);
      next.setDate(next.getDate() + dayCount);
      return next;
    });
  }, [dayCount]);

  const goToToday = useCallback(() => {
    setSelectedDate(new Date());
  }, []);

  // Create block at next available time
  const createBlockAtNextAvailable = useCallback(async () => {
    const todayStr = formatDateStr(selectedDate);
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMin = timeToMinutes(workDayStart);
    const endMin = timeToMinutes(workDayEnd);

    // Find next available slot
    const dayBlocks = store.listBlocks(todayStr);
    let candidateStart = Math.max(snapToGrid(nowMinutes, gridInterval), startMin);

    // Check for overlaps and find a free slot
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidateEnd = Math.min(candidateStart + defaultDuration, endMin);
      if (candidateEnd <= candidateStart || candidateStart >= endMin) break;

      const hasOverlap = dayBlocks.some((b) =>
        isOverlapping(
          minutesToTime(candidateStart),
          minutesToTime(candidateEnd),
          b.startTime,
          b.endTime,
        ),
      );

      if (!hasOverlap) {
        const block = await store.createBlock({
          title: "New Block",
          date: todayStr,
          startTime: minutesToTime(candidateStart),
          endTime: minutesToTime(candidateEnd),
          locked: false,
        });
        refreshData();
        setEditingBlockId(block.id);
        setEditingTitle("New Block");
        return;
      }

      candidateStart += gridInterval;
    }
  }, [selectedDate, workDayStart, workDayEnd, gridInterval, defaultDuration, store, refreshData]);

  // Delete selected block
  const deleteSelectedBlock = useCallback(async () => {
    if (!selectedBlockId) return;
    try {
      await store.deleteBlock(selectedBlockId);
      setSelectedBlockId(null);
      refreshData();
    } catch {
      // Block might not exist
    }
  }, [selectedBlockId, store, refreshData]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          goToPrevious();
          break;
        case "ArrowRight":
          e.preventDefault();
          goToNext();
          break;
        case "t":
        case "T":
          e.preventDefault();
          goToToday();
          break;
        case "d":
        case "D":
          e.preventDefault();
          setDayCount(1);
          break;
        case "w":
        case "W":
          e.preventDefault();
          setDayCount(7);
          break;
        case "s":
        case "S":
          e.preventDefault();
          setSidebarCollapsed((c) => !c);
          break;
        case "n":
        case "N":
          e.preventDefault();
          createBlockAtNextAvailable();
          break;
        case "f":
        case "F":
          e.preventDefault();
          // Focus on active/selected block — handled by FocusTimer component
          if (activeBlock) {
            setSelectedBlockId(activeBlock.id);
          }
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          deleteSelectedBlock();
          break;
        default:
          if (e.key >= "1" && e.key <= "7") {
            e.preventDefault();
            setDayCount(parseInt(e.key) as ViewMode);
          }
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goToPrevious, goToNext, goToToday, createBlockAtNextAvailable, deleteSelectedBlock, activeBlock]);

  // Settings change handler
  const handleSettingChange = useCallback(
    (key: string, value: string) => {
      plugin.settings.set(key, value);
      setSettingsVersion((v) => v + 1);
    },
    [plugin.settings],
  );

  // Focus timer status bar update
  const handleFocusStatusUpdate = useCallback(
    (_status: string) => {
      // Status bar integration — future enhancement
    },
    [],
  );

  // Sidebar resize via divider drag
  const handleDividerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onPointerMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        const newWidth = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, startWidth + delta),
        );
        setSidebarWidth(newWidth);
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [sidebarWidth],
  );

  // DnD handlers
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
    [],
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
    [store, selectedDate, defaultDuration, workDayEnd, gridInterval, refreshData, slotsState],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setActiveDragType(null);
    setDragConflict(false);
  }, []);

  // Block operations
  const handleBlockCreate = useCallback(
    async (_date: string, startTime: string, endTime: string) => {
      const block = await store.createBlock({
        title: "New Block",
        date: _date,
        startTime,
        endTime,
        locked: false,
      });
      refreshData();
      setEditingBlockId(block.id);
      setEditingTitle("New Block");
    },
    [store, refreshData],
  );

  const handleBlockMove = useCallback(
    async (blockId: string, newDate: string, newStartTime: string) => {
      const block = blocks.find((b) => b.id === blockId);
      if (!block) return;
      const duration = timeToMinutes(block.endTime) - timeToMinutes(block.startTime);
      const newEndTime = minutesToTime(timeToMinutes(newStartTime) + duration);
      await store.updateBlock(blockId, {
        date: newDate,
        startTime: newStartTime,
        endTime: newEndTime,
      });
      refreshData();
    },
    [store, blocks, refreshData],
  );

  const handleBlockResize = useCallback(
    async (blockId: string, newStartTime: string, newEndTime: string) => {
      await store.updateBlock(blockId, {
        startTime: newStartTime,
        endTime: newEndTime,
      });
      refreshData();
    },
    [store, refreshData],
  );

  const handleBlockClick = useCallback((blockId: string) => {
    setSelectedBlockId(blockId);
  }, []);

  const handleSlotClick = useCallback((_slotId: string) => {
    // Future: open slot detail panel
  }, []);

  const handleSlotCreate = useCallback(
    async (date: string, startTime: string, endTime: string) => {
      await store.createSlot({
        title: "Focus Block",
        date,
        startTime,
        endTime,
        taskIds: [],
      });
      refreshData();
    },
    [store, refreshData],
  );

  const handleTaskToggle = useCallback(
    async (_taskId: string) => {
      // Task toggle requires task:write + update API — future enhancement
    },
    [],
  );

  const handleTaskClick = useCallback((_taskId: string) => {
    // Future: open task detail
  }, []);

  const handleSlotResize = useCallback(
    async (slotId: string, _edge: "top" | "bottom") => {
      void slotId;
    },
    [],
  );

  // Inline editing handlers
  const handleEditingConfirm = useCallback(async () => {
    if (!editingBlockId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      await store.updateBlock(editingBlockId, { title: trimmed });
    } else {
      await store.deleteBlock(editingBlockId);
    }
    setEditingBlockId(null);
    setEditingTitle("");
    refreshData();
  }, [editingBlockId, editingTitle, store, refreshData]);

  const handleEditingCancel = useCallback(async () => {
    if (!editingBlockId) return;
    await store.deleteBlock(editingBlockId);
    setEditingBlockId(null);
    setEditingTitle("");
    refreshData();
  }, [editingBlockId, store, refreshData]);

  // Resolve active drag item for DragOverlay
  const activeDragTask =
    activeDragType === "task"
      ? tasks.find((t) => t.id === activeDragId)
      : null;
  const activeDragBlock =
    activeDragType === "block"
      ? blocks.find((b) => b.id === activeDragId)
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
  }, [activeDragBlock, blocks]);

  // Slot renderer passed to timeline columns
  const renderSlot = useCallback(
    (slot: TimeSlot) => (
      <TimeSlotCard
        key={slot.id}
        slot={slot}
        tasks={tasks}
        projects={projects}
        pixelsPerHour={getPixelsPerHour(dayCount)}
        workDayStart={workDayStart}
        onSlotClick={handleSlotClick}
        onTaskClick={handleTaskClick}
        onTaskToggle={handleTaskToggle}
        onResizeStart={handleSlotResize}
      />
    ),
    [tasks, projects, dayCount, workDayStart, handleSlotClick, handleTaskClick, handleTaskToggle, handleSlotResize],
  );

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

  const pixelsPerHour = getPixelsPerHour(dayCount);

  // Common timeline props
  const timelineProps = {
    blocks,
    slots: slotsState,
    workDayStart,
    workDayEnd,
    gridInterval,
    pixelsPerHour,
    taskStatuses,
    editingBlockId,
    editingTitle,
    onEditingTitleChange: setEditingTitle,
    onEditingConfirm: handleEditingConfirm,
    onEditingCancel: handleEditingCancel,
    onBlockCreate: handleBlockCreate,
    onBlockMove: handleBlockMove,
    onBlockResize: handleBlockResize,
    onBlockClick: handleBlockClick,
    onSlotClick: handleSlotClick,
    onSlotCreate: handleSlotCreate,
    renderSlot,
  };

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Replan banner for stale blocks */}
      <ReplanBanner
        store={store}
        taskStatuses={taskStatuses}
        onReplanComplete={refreshData}
      />

      {/* Navigation bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface flex-shrink-0">
        <button
          onClick={goToPrevious}
          className="p-1 rounded hover:bg-surface-secondary text-on-surface-secondary transition-colors"
          aria-label="Previous day"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          onClick={goToToday}
          className="px-3 py-1 text-sm font-medium rounded-md bg-surface-secondary hover:bg-surface-tertiary text-on-surface transition-colors"
        >
          Today
        </button>
        <button
          onClick={goToNext}
          className="p-1 rounded hover:bg-surface-secondary text-on-surface-secondary transition-colors"
          aria-label="Next day"
        >
          <ChevronRight size={18} />
        </button>

        <span className="text-sm text-on-surface-secondary flex-1 text-center" data-testid="date-range-label">
          {formatDateRange(selectedDate, dayCount)}
        </span>

        {/* Focus timer for active block */}
        {activeBlock && (
          <FocusTimer
            block={activeBlock}
            onComplete={refreshData}
            onStatusUpdate={handleFocusStatusUpdate}
          />
        )}

        {/* View mode selector */}
        <div className="flex items-center gap-0.5 bg-surface-secondary rounded-md p-0.5" data-testid="view-mode-selector">
          {VIEW_MODE_LABELS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setDayCount(value)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                dayCount === value
                  ? "bg-accent text-white"
                  : "text-on-surface-secondary hover:text-on-surface"
              }`}
              data-testid={`view-mode-${value}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Settings popover */}
        <SettingsPopover
          workDayStart={workDayStart}
          workDayEnd={workDayEnd}
          gridInterval={gridIntervalStr}
          defaultDuration={defaultDurationStr}
          onSettingChange={handleSettingChange}
        />
      </div>

      {/* Main content */}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex flex-1 overflow-hidden">
          {/* Task sidebar */}
          {!sidebarCollapsed && (
            <>
              <div
                className="flex-shrink-0 hidden md:flex"
                style={{ width: sidebarWidth }}
              >
                <TaskSidebar
                  tasks={tasks}
                  scheduledTaskIds={scheduledTaskIds}
                  groups={sidebarGroups}
                />
              </div>

              {/* Resize divider */}
              <div
                ref={dividerRef}
                className="w-1 flex-shrink-0 bg-border hover:bg-accent/50 cursor-col-resize transition-colors hidden md:block"
                onPointerDown={handleDividerPointerDown}
                data-testid="sidebar-divider"
              />
            </>
          )}

          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarCollapsed((c) => !c)}
            className="flex-shrink-0 w-6 flex items-center justify-center hover:bg-surface-secondary text-on-surface-muted transition-colors hidden md:flex"
            aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            data-testid="sidebar-toggle"
          >
            {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>

          {/* Timeline */}
          {dayCount === 1 ? (
            <DayTimeline
              date={selectedDate}
              showHeader={false}
              {...timelineProps}
            />
          ) : (
            <WeekTimeline
              startDate={selectedDate}
              dayCount={dayCount}
              {...timelineProps}
            />
          )}
        </div>

        {/* Drag overlay */}
        <DragOverlay>
          {activeDragTask ? <TaskDragPreview task={activeDragTask} /> : null}
          {activeDragBlock ? (
            <BlockDragPreview block={activeDragBlock} hasConflict={dragConflict} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
