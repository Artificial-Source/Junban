import { useCallback } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, CalendarClock, Sparkles } from "lucide-react";
import type { TimeSlot } from "../types.js";
import { useTimeblocking } from "../context.js";
import { DayTimeline } from "./DayTimeline.js";
import { WeekTimeline } from "./WeekTimeline.js";
import { TaskSidebar } from "./TaskSidebar.js";
import { TimeSlotCard } from "./TimeSlotCard.js";
import { TaskDragPreview, BlockDragPreview } from "./DragPreview.js";
import { ReplanBanner } from "./ReplanBanner.js";
import { SettingsPopover } from "./SettingsPopover.js";
import { FocusTimer } from "./FocusTimer.js";
import { SchedulePreviewBar } from "./SchedulePreviewBar.js";
import { ContextMenu } from "../../../../ui/components/ContextMenu.js";
import { VIEW_MODE_LABELS, getPixelsPerHour, formatDateRange } from "../utils/timeblocking-utils.js";
import { useTimeblockingState } from "../hooks/useTimeblockingState.js";
import { useTimeblockingData } from "../hooks/useTimeblockingData.js";
import { useTimeblockingNavigation } from "../hooks/useTimeblockingNavigation.js";
import { useTimeblockingBlocks } from "../hooks/useTimeblockingBlocks.js";
import { useTimeblockingDnD } from "../hooks/useTimeblockingDnD.js";
import { useTimeblockingContextMenu } from "../hooks/useTimeblockingContextMenu.js";
import { useTimeblockingKeyboard } from "../hooks/useTimeblockingKeyboard.js";
import { useAutoSchedule } from "../hooks/useAutoSchedule.js";

export function TimeblockingView() {
  const plugin = useTimeblocking();
  const store = plugin.store;

  const {
    selectedDate, setSelectedDate, dayCount, setDayCount,
    blocks, setBlocks, slotsState, setSlotsState, tasks, setTasks,
    activeDragId, activeDragType, dragConflict,
    setActiveDragId, setActiveDragType, setDragConflict,
    editingBlockId, editingTitle, setEditingBlockId, setEditingTitle,
    sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth, dividerRef,
    selectedBlockId, setSelectedBlockId,
    contextMenu, setContextMenu, clipboardBlock, setClipboardBlock,
    setSettingsVersion,
    workDayStart, workDayEnd, gridIntervalStr, defaultDurationStr,
    gridInterval, defaultDuration, rangeStart, rangeEnd, sensors,
    taskStatuses, projects, scheduledTaskIds, activeBlock, sidebarGroups,
  } = useTimeblockingState(plugin, store);

  const { refreshData, refreshTasks: _refreshTasks } = useTimeblockingData({
    store,
    plugin,
    selectedDate,
    dayCount,
    rangeStart,
    rangeEnd,
    setBlocks,
    setSlotsState,
    setTasks,
  });

  const { goToPrevious, goToNext, goToToday } = useTimeblockingNavigation({
    dayCount,
    setSelectedDate,
  });

  const blockOps = useTimeblockingBlocks({
    store,
    plugin,
    blocks,
    slotsState,
    selectedDate,
    selectedBlockId,
    editingBlockId,
    editingTitle,
    sidebarWidth,
    workDayStart,
    workDayEnd,
    gridInterval,
    defaultDuration,
    refreshData,
    setEditingBlockId,
    setEditingTitle,
    setSelectedBlockId,
    setSettingsVersion,
    setSidebarWidth,
  });

  const dnd = useTimeblockingDnD({
    store,
    blocks,
    tasks,
    slotsState,
    selectedDate,
    activeDragId,
    activeDragType,
    defaultDuration,
    workDayEnd,
    gridInterval,
    refreshData,
    setActiveDragId,
    setActiveDragType,
    setDragConflict,
  });

  const ctxMenu = useTimeblockingContextMenu({
    store,
    blocks,
    slotsState,
    contextMenu,
    clipboardBlock,
    selectedBlockId,
    defaultDuration,
    workDayEnd,
    refreshData,
    setContextMenu,
    setClipboardBlock,
    setEditingBlockId,
    setEditingTitle,
    setSelectedBlockId,
    handleBlockCreate: blockOps.handleBlockCreate,
    handleSlotCreate: blockOps.handleSlotCreate,
    handleDuplicateBlock: blockOps.handleDuplicateBlock,
    handleToggleLock: blockOps.handleToggleLock,
    handleChangeColor: blockOps.handleChangeColor,
    handleClearSlotTasks: blockOps.handleClearSlotTasks,
    handleDeleteSlot: blockOps.handleDeleteSlot,
  });

  useTimeblockingKeyboard({
    goToPrevious,
    goToNext,
    goToToday,
    createBlockAtNextAvailable: blockOps.createBlockAtNextAvailable,
    deleteSelectedBlock: blockOps.deleteSelectedBlock,
    activeBlock,
    setDayCount,
    setSidebarCollapsed,
    setSelectedBlockId,
  });

  const autoScheduleHook = useAutoSchedule({
    store,
    tasks,
    selectedDate,
    workDayStart,
    workDayEnd,
    gridInterval,
    defaultDuration,
    refreshData,
  });

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
        onSlotClick={blockOps.handleSlotClick}
        onTaskClick={blockOps.handleTaskClick}
        onTaskToggle={blockOps.handleTaskToggle}
        onResizeStart={blockOps.handleSlotResize}
        onContextMenu={ctxMenu.handleSlotContextMenu}
      />
    ),
    [tasks, projects, dayCount, workDayStart, blockOps.handleSlotClick, blockOps.handleTaskClick, blockOps.handleTaskToggle, blockOps.handleSlotResize, ctxMenu.handleSlotContextMenu],
  );

  const pixelsPerHour = getPixelsPerHour(dayCount);

  // Common timeline props
  const timelineProps = {
    blocks: blocks,
    slots: slotsState,
    workDayStart: workDayStart,
    workDayEnd: workDayEnd,
    gridInterval: gridInterval,
    pixelsPerHour,
    taskStatuses: taskStatuses,
    editingBlockId: editingBlockId,
    editingTitle: editingTitle,
    onEditingTitleChange: setEditingTitle,
    onEditingConfirm: blockOps.handleEditingConfirm,
    onEditingCancel: blockOps.handleEditingCancel,
    onBlockCreate: blockOps.handleBlockCreate,
    onBlockMove: blockOps.handleBlockMove,
    onBlockResize: blockOps.handleBlockResize,
    onBlockClick: blockOps.handleBlockClick,
    onBlockContextMenu: ctxMenu.handleBlockContextMenu,
    onSlotClick: blockOps.handleSlotClick,
    onSlotCreate: blockOps.handleSlotCreate,
    onTimelineContextMenu: ctxMenu.handleTimelineContextMenu,
    renderSlot,
    proposedBlocks: autoScheduleHook.preview?.proposed ?? null,
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
            onStatusUpdate={blockOps.handleFocusStatusUpdate}
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

        {/* Auto-schedule button */}
        <button
          onClick={autoScheduleHook.generatePreview}
          disabled={autoScheduleHook.preview !== null}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Auto-schedule tasks"
          data-testid="auto-schedule-btn"
          title="Auto-schedule pending tasks into available time gaps"
        >
          <CalendarClock size={14} />
          <Sparkles size={10} />
          <span className="hidden sm:inline">Auto-schedule</span>
        </button>

        {/* Settings popover */}
        <SettingsPopover
          workDayStart={workDayStart}
          workDayEnd={workDayEnd}
          gridInterval={gridIntervalStr}
          defaultDuration={defaultDurationStr}
          onSettingChange={blockOps.handleSettingChange}
        />
      </div>

      {/* Main content */}
      <DndContext
        sensors={sensors}
        onDragStart={dnd.handleDragStart}
        onDragEnd={dnd.handleDragEnd}
        onDragCancel={dnd.handleDragCancel}
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
                  onTaskClick={blockOps.handleTaskClick}
                />
              </div>

              {/* Resize divider */}
              <div
                ref={dividerRef}
                className="w-1 flex-shrink-0 bg-border hover:bg-accent/50 cursor-col-resize transition-colors hidden md:block"
                onPointerDown={blockOps.handleDividerPointerDown}
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
          {dnd.activeDragTask ? <TaskDragPreview task={dnd.activeDragTask} /> : null}
          {dnd.activeDragBlock ? (
            <BlockDragPreview block={dnd.activeDragBlock} hasConflict={dragConflict} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Auto-schedule preview bar */}
      {autoScheduleHook.preview && (
        <SchedulePreviewBar
          schedule={autoScheduleHook.preview}
          onApply={autoScheduleHook.applyPreview}
          onCancel={autoScheduleHook.cancelPreview}
          isApplying={autoScheduleHook.isApplying}
        />
      )}

      {/* Context menu */}
      {contextMenu && ctxMenu.contextMenuItems.length > 0 && (
        <ContextMenu
          items={ctxMenu.contextMenuItems}
          position={contextMenu.position}
          onClose={ctxMenu.closeContextMenu}
        />
      )}
    </div>
  );
}
