/**
 * First-party Day/Week timeblocking view.
 * Uses typed time-block/slot APIs and civil-local date/time only — no UTC Date drift,
 * no drag libraries, no AI auto-schedule.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import {
  ApiError,
  appendTimeSlotTask,
  createTimeBlock,
  createTimeSlot,
  deleteTimeBlock,
  deleteTimeSlot,
  getTemporalSettings,
  listTimeBlocks,
  listTimeSlots,
  moveTimeBlock,
  patchTimeBlock,
  patchTimeSlot,
  removeTimeSlotTask,
  replaceTimeSlotTasks,
  replanTimeBlocks,
  resizeTimeBlock,
  type MutationResponse,
  type ProjectDto,
  type ReplanTimeBlocksActionDto,
  type TaskDto,
  type TemporalSettingsResponse,
  type TimeBlockDto,
  type TimeSlotDto,
} from "../api/client";
import { SegmentedControl } from "../components/SegmentedControl";
import { ViewSkeleton } from "../components/Skeleton";
import { useWorkspace } from "../context/WorkspaceContext";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useViewTasks } from "../hooks/useViewTasks";
import { todayKey } from "../lib/dates";
import { toCivilDateKey } from "./calendar/calendarRange";
import {
  BlockEditorDialog,
  blockToEditorValues,
  createDraftValues,
  slotToEditorValues,
  type BlockEditorValues,
} from "./timeblocking/BlockEditorDialog";
import { ReplanBanner } from "./timeblocking/ReplanBanner";
import { SettingsPopover } from "./timeblocking/SettingsPopover";
import { TaskSidebar } from "./timeblocking/TaskSidebar";
import { TimelineGrid } from "./timeblocking/TimelineGrid";
import {
  civilDatesInRange,
  civilTimeToMinutes,
  DEFAULT_BLOCK_DURATION_MINUTES,
  DEFAULT_GRID_INTERVAL_MINUTES,
  DEFAULT_WORK_DAY_END,
  DEFAULT_WORK_DAY_START,
  dayCountForMode,
  formatTimeblockingRangeLabel,
  minutesToCivilTime,
  replanLookbackRange,
  timeblockingRequestRange,
  type TimeblockingMode,
} from "./timeblocking/timeblockingRange";

interface TimeblockingProps {
  onSelectTask?: (id: string) => void;
  onToggleTask?: (id: string) => Promise<boolean>;
}

export function Timeblocking({ onSelectTask, onToggleTask }: TimeblockingProps) {
  const { catalog, runMutation } = useWorkspace();
  const { completeTask, uncompleteTask } = useTaskMutations();
  const taskQuery = useViewTasks({ status: "pending", limit: 100 });

  const [mode, setMode] = useState<TimeblockingMode>("day");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [blocks, setBlocks] = useState<TimeBlockDto[]>([]);
  const [slots, setSlots] = useState<TimeSlotDto[]>([]);
  const [staleBlocks, setStaleBlocks] = useState<TimeBlockDto[]>([]);
  const [settings, setSettings] = useState<TemporalSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editor, setEditor] = useState<BlockEditorValues | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const liveRegionId = useId();
  const requestSeq = useRef(0);
  const mutationPendingRef = useRef(false);

  const workDayStart = DEFAULT_WORK_DAY_START;
  const workDayEnd = DEFAULT_WORK_DAY_END;
  const gridInterval = DEFAULT_GRID_INTERVAL_MINUTES;
  const defaultDuration = DEFAULT_BLOCK_DURATION_MINUTES;

  const range = useMemo(() => timeblockingRequestRange(selectedDate, mode), [selectedDate, mode]);

  const projects = catalog?.projects ?? [];
  const projectsById = useMemo(() => {
    const map = new Map<string, ProjectDto>();
    for (const project of catalog?.projects ?? []) map.set(project.id, project);
    return map;
  }, [catalog?.projects]);

  const tasksById = useMemo(() => {
    const map = new Map<string, TaskDto>();
    for (const task of taskQuery.tasks) map.set(task.id, task);
    return map;
  }, [taskQuery.tasks]);

  const scheduledTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const block of blocks) {
      if (block.task_id) ids.add(block.task_id);
    }
    for (const slot of slots) {
      for (const taskId of slot.task_ids ?? []) ids.add(taskId);
    }
    return ids;
  }, [blocks, slots]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const lookback = replanLookbackRange(todayKey());
      // Blocks support inclusive from/to. Slots are single-date in the typed API,
      // so fan out one request per civil day in the visible window.
      const slotDates = civilDatesInRange(range.from, range.to);
      const [blockPage, slotPages, temporal, stalePage] = await Promise.all([
        listTimeBlocks({ from: range.from, to: range.to }),
        Promise.all(slotDates.map((date) => listTimeSlots({ date }))),
        getTemporalSettings(),
        listTimeBlocks({ from: lookback.from, to: lookback.to }),
      ]);
      if (seq !== requestSeq.current) return;
      const mergedSlots = new Map<string, TimeSlotDto>();
      for (const page of slotPages) {
        for (const item of page.time_slots) mergedSlots.set(item.occurrence_key, item);
      }
      setBlocks(blockPage.time_blocks);
      setSlots([...mergedSlots.values()]);
      setSettings(temporal);
      setStaleBlocks(stalePage.time_blocks.filter((block) => !block.locked));
    } catch (caught) {
      if (seq !== requestSeq.current) return;
      setError(caught instanceof ApiError ? caught.message : "Could not load timeblocking.");
      setBlocks([]);
      setSlots([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const runTbMutation = useCallback(
    async (
      label: string,
      execute: (operationId: string) => Promise<MutationResponse>,
    ): Promise<boolean> => {
      if (mutationPendingRef.current) return false;
      mutationPendingRef.current = true;
      setMutationPending(true);
      setMutationError(null);
      try {
        const result = await runMutation((operationId) => execute(operationId), {
          successToast: label,
          undoLabel: label,
        });
        if (!result) {
          setMutationError("The timeblocking change failed.");
          setLiveMessage("Timeblocking change failed.");
          return false;
        }
        await load();
        setLiveMessage(label);
        return true;
      } catch (caught) {
        const message =
          caught instanceof ApiError ? caught.message : "The timeblocking change failed.";
        setMutationError(message);
        setLiveMessage(message);
        return false;
      } finally {
        mutationPendingRef.current = false;
        setMutationPending(false);
      }
    },
    [runMutation, load],
  );

  const handleCreateBlock = useCallback(
    (date: string, start: string, end: string, taskId?: string | null) => {
      const task = taskId ? tasksById.get(taskId) : undefined;
      const title = task?.title?.trim() || "New block";
      const color = task?.project_id ? projectsById.get(task.project_id)?.color : undefined;
      void runTbMutation("Create time block", (operationId) =>
        createTimeBlock(
          {
            title,
            date,
            start,
            end,
            ...(taskId ? { task_id: taskId } : {}),
            ...(color ? { color } : {}),
          },
          operationId,
        ),
      );
    },
    [tasksById, projectsById, runTbMutation],
  );

  const handleSaveEditor = useCallback(
    async (values: BlockEditorValues): Promise<boolean> => {
      const label =
        values.kind === "slot"
          ? values.ownerId
            ? "Update time slot"
            : "Create time slot"
          : values.ownerId
            ? "Update time block"
            : "Create time block";
      const ok = await runTbMutation(label, async (operationId) => {
        if (values.kind === "slot") {
          if (values.ownerId) {
            return patchTimeSlot(
              values.ownerId,
              {
                title: values.title,
                date: values.date,
                start: values.start,
                end: values.end,
                color: values.color,
                project_id: values.projectId,
                recurrence_rule: values.recurrenceRule,
              },
              operationId,
            );
          }
          return createTimeSlot(
            {
              title: values.title,
              date: values.date,
              start: values.start,
              end: values.end,
              color: values.color,
              project_id: values.projectId,
              recurrence_rule: values.recurrenceRule,
            },
            operationId,
          );
        }
        if (values.ownerId) {
          return patchTimeBlock(
            values.ownerId,
            {
              title: values.title,
              date: values.date,
              start: values.start,
              end: values.end,
              color: values.color,
              locked: values.locked,
              task_id: values.taskId,
              slot_id: values.slotId,
              recurrence_rule: values.recurrenceRule,
            },
            operationId,
          );
        }
        return createTimeBlock(
          {
            title: values.title,
            date: values.date,
            start: values.start,
            end: values.end,
            color: values.color,
            locked: values.locked,
            task_id: values.taskId,
            slot_id: values.slotId,
            recurrence_rule: values.recurrenceRule,
          },
          operationId,
        );
      });
      if (ok) setEditor(null);
      return ok;
    },
    [runTbMutation],
  );

  const handleDeleteEditor = useCallback(
    async (values: BlockEditorValues): Promise<boolean> => {
      if (!values.ownerId) return false;
      const ok = await runTbMutation(
        values.kind === "slot" ? "Delete time slot" : "Delete time block",
        async (operationId) =>
          values.kind === "slot"
            ? deleteTimeSlot(values.ownerId!, operationId)
            : deleteTimeBlock(values.ownerId!, operationId),
      );
      if (ok) {
        setEditor(null);
        setSelectedKey(null);
      }
      return ok;
    },
    [runTbMutation],
  );

  const handleMoveBlock = useCallback(
    (ownerId: string, date: string, start: string, end: string) => {
      void runTbMutation("Move time block", (operationId) =>
        moveTimeBlock(ownerId, { date, start, end }, operationId),
      );
    },
    [runTbMutation],
  );

  const handleResizeBlock = useCallback(
    (ownerId: string, date: string, start: string, end: string) => {
      void runTbMutation("Resize time block", (operationId) =>
        resizeTimeBlock(ownerId, { date, start, end }, operationId),
      );
    },
    [runTbMutation],
  );

  const handleResizeSlot = useCallback(
    (ownerId: string, date: string, start: string, end: string) => {
      void runTbMutation("Resize time slot", (operationId) =>
        patchTimeSlot(ownerId, { date, start, end }, operationId),
      );
    },
    [runTbMutation],
  );

  const handleAppendSlotTask = useCallback(
    (slotOwnerId: string, taskId: string) => {
      void runTbMutation("Add task to slot", (operationId) =>
        appendTimeSlotTask(slotOwnerId, { task_id: taskId }, operationId),
      );
    },
    [runTbMutation],
  );

  const handleRemoveSlotTask = useCallback(
    (slotOwnerId: string, taskId: string) => {
      void runTbMutation("Remove task from slot", (operationId) =>
        removeTimeSlotTask(slotOwnerId, taskId, operationId),
      );
    },
    [runTbMutation],
  );

  const handleReorderSlotTask = useCallback(
    (slotOwnerId: string, taskId: string, direction: -1 | 1) => {
      const slot = slots.find((item) => item.id === slotOwnerId);
      if (!slot) return;
      const ids = [...(slot.task_ids ?? [])];
      const index = ids.indexOf(taskId);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= ids.length) return;
      const copy = [...ids];
      const [moved] = copy.splice(index, 1);
      copy.splice(next, 0, moved!);
      void runTbMutation("Reorder slot tasks", (operationId) =>
        replaceTimeSlotTasks(slotOwnerId, { task_ids: copy }, operationId),
      );
    },
    [slots, runTbMutation],
  );

  const handleToggleTask = useCallback(
    async (taskId: string) => {
      if (onToggleTask) {
        await onToggleTask(taskId);
        return;
      }
      const task = tasksById.get(taskId);
      if (!task) return;
      if (task.status === "completed") await uncompleteTask(taskId);
      else await completeTask(taskId);
      taskQuery.reload();
    },
    [onToggleTask, tasksById, completeTask, uncompleteTask, taskQuery],
  );

  const handleReplan = useCallback(
    async (action: ReplanTimeBlocksActionDto): Promise<boolean> => {
      const labels: Record<ReplanTimeBlocksActionDto, string> = {
        move_to_today: "Replan blocks to today",
        move_to_tomorrow: "Replan blocks to tomorrow",
        delete: "Delete past unlocked blocks",
      };
      return runTbMutation(labels[action], (operationId) =>
        replanTimeBlocks({ action }, operationId),
      );
    },
    [runTbMutation],
  );

  const selectedBlock = blocks.find((block) => block.occurrence_key === selectedKey) ?? null;
  const selectedSlot = slots.find((slot) => slot.occurrence_key === selectedKey) ?? null;

  const nudgeSelected = useCallback(
    (deltaMinutes: number, resizeEdge: "start" | "end" | null = null) => {
      if (selectedBlock) {
        const start = civilTimeToMinutes(selectedBlock.start) ?? 0;
        const end = civilTimeToMinutes(selectedBlock.end) ?? start + 30;
        if (resizeEdge === "start") {
          handleResizeBlock(
            selectedBlock.id,
            selectedBlock.date,
            minutesToCivilTime(start + deltaMinutes),
            minutesToCivilTime(end),
          );
        } else if (resizeEdge === "end") {
          handleResizeBlock(
            selectedBlock.id,
            selectedBlock.date,
            minutesToCivilTime(start),
            minutesToCivilTime(end + deltaMinutes),
          );
        } else {
          handleMoveBlock(
            selectedBlock.id,
            selectedBlock.date,
            minutesToCivilTime(start + deltaMinutes),
            minutesToCivilTime(end + deltaMinutes),
          );
        }
        return;
      }
      if (selectedSlot) {
        const start = civilTimeToMinutes(selectedSlot.start) ?? 0;
        const end = civilTimeToMinutes(selectedSlot.end) ?? start + 60;
        if (resizeEdge === "start") {
          handleResizeSlot(
            selectedSlot.id,
            selectedSlot.date,
            minutesToCivilTime(start + deltaMinutes),
            minutesToCivilTime(end),
          );
        } else if (resizeEdge === "end") {
          handleResizeSlot(
            selectedSlot.id,
            selectedSlot.date,
            minutesToCivilTime(start),
            minutesToCivilTime(end + deltaMinutes),
          );
        } else {
          handleResizeSlot(
            selectedSlot.id,
            selectedSlot.date,
            minutesToCivilTime(start + deltaMinutes),
            minutesToCivilTime(end + deltaMinutes),
          );
        }
      }
    },
    [selectedBlock, selectedSlot, handleMoveBlock, handleResizeBlock, handleResizeSlot],
  );

  const deleteSelected = useCallback(() => {
    if (selectedBlock) {
      void runTbMutation("Delete time block", (operationId) =>
        deleteTimeBlock(selectedBlock.id, operationId),
      ).then((ok) => {
        if (ok) setSelectedKey(null);
      });
      return;
    }
    if (selectedSlot) {
      void runTbMutation("Delete time slot", (operationId) =>
        deleteTimeSlot(selectedSlot.id, operationId),
      ).then((ok) => {
        if (ok) setSelectedKey(null);
      });
    }
  }, [selectedBlock, selectedSlot, runTbMutation]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editor) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const step = gridInterval;
      if (event.key === "ArrowLeft" && !event.metaKey && !event.ctrlKey && !selectedKey) {
        event.preventDefault();
        setSelectedDate((date) => {
          const prev = new Date(date);
          prev.setDate(prev.getDate() - dayCountForMode(mode));
          return prev;
        });
      } else if (event.key === "ArrowRight" && !event.metaKey && !event.ctrlKey && !selectedKey) {
        event.preventDefault();
        setSelectedDate((date) => {
          const next = new Date(date);
          next.setDate(next.getDate() + dayCountForMode(mode));
          return next;
        });
      } else if (event.key === "ArrowUp" && selectedKey) {
        event.preventDefault();
        nudgeSelected(-step, event.shiftKey ? "start" : null);
      } else if (event.key === "ArrowDown" && selectedKey) {
        event.preventDefault();
        nudgeSelected(step, event.shiftKey ? "end" : null);
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedKey) {
        event.preventDefault();
        deleteSelected();
      } else if (event.key === "Enter" && selectedKey) {
        event.preventDefault();
        if (selectedBlock) setEditor(blockToEditorValues(selectedBlock));
        if (selectedSlot) setEditor(slotToEditorValues(selectedSlot));
      } else if (event.key === "t" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setSelectedDate(new Date());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    editor,
    mode,
    selectedKey,
    selectedBlock,
    selectedSlot,
    gridInterval,
    nudgeSelected,
    deleteSelected,
  ]);

  const periodLabel = formatTimeblockingRangeLabel(selectedDate, mode);
  const isToday = toCivilDateKey(selectedDate) === todayKey();

  const openAddBlock = () => {
    const date = toCivilDateKey(selectedDate);
    setEditor(
      createDraftValues({
        kind: "block",
        date,
        start: workDayStart,
        end: minutesToCivilTime((civilTimeToMinutes(workDayStart) ?? 9 * 60) + defaultDuration),
      }),
    );
  };

  const openAddSlot = () => {
    const date = toCivilDateKey(selectedDate);
    setEditor(
      createDraftValues({
        kind: "slot",
        date,
        start: "13:00",
        end: "14:00",
        title: "Time slot",
      }),
    );
  };

  const scheduleTaskNow = (taskId: string) => {
    const task = tasksById.get(taskId);
    const date = toCivilDateKey(selectedDate);
    const duration = task?.estimated_minutes ?? defaultDuration;
    const start = workDayStart;
    const end = minutesToCivilTime((civilTimeToMinutes(start) ?? 9 * 60) + duration);
    setEditor(
      createDraftValues({
        kind: "block",
        date,
        start,
        end,
        taskId,
        title: task?.title,
      }),
    );
  };

  return (
    <div
      className="flex h-full min-h-0 -m-3 flex-col md:-m-6"
      aria-busy={loading || mutationPending || undefined}
      data-testid="timeblocking-view"
    >
      <ReplanBanner
        staleBlocks={staleBlocks}
        pending={mutationPending}
        error={mutationError}
        onReplan={handleReplan}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-surface px-2 py-2 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() =>
            setSelectedDate((date) => {
              const prev = new Date(date);
              prev.setDate(prev.getDate() - dayCountForMode(mode));
              return prev;
            })
          }
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1 text-on-surface-secondary hover:bg-surface-secondary sm:min-h-0 sm:min-w-0"
          aria-label="Previous"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          onClick={() => setSelectedDate(new Date())}
          className={`min-h-[44px] rounded-md px-3 py-1 text-sm font-medium sm:min-h-0 ${
            isToday
              ? "bg-surface-secondary text-on-surface"
              : "bg-surface-secondary text-on-surface hover:bg-surface-tertiary"
          }`}
        >
          Today
        </button>
        <button
          type="button"
          onClick={() =>
            setSelectedDate((date) => {
              const next = new Date(date);
              next.setDate(next.getDate() + dayCountForMode(mode));
              return next;
            })
          }
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1 text-on-surface-secondary hover:bg-surface-secondary sm:min-h-0 sm:min-w-0"
          aria-label="Next"
        >
          <ChevronRight size={18} />
        </button>

        <span
          className="min-w-0 flex-1 truncate text-center text-xs text-on-surface-secondary sm:text-sm"
          data-testid="date-range-label"
        >
          {periodLabel}
        </span>

        <div data-testid="view-mode-selector">
          <SegmentedControl
            label="Timeblocking view"
            options={[
              { value: "day" as TimeblockingMode, label: "Day" },
              { value: "week" as TimeblockingMode, label: "Week" },
            ]}
            value={mode}
            onChange={setMode}
          />
        </div>

        <button
          type="button"
          onClick={openAddBlock}
          aria-label="Add Block"
          className="flex min-h-[44px] items-center gap-1 rounded-md bg-accent-action px-2.5 py-1 text-xs font-medium text-on-accent-action hover:bg-accent-action-hover sm:min-h-0"
          data-testid="add-block-btn"
        >
          <Plus size={14} aria-hidden="true" />
          <span className="hidden sm:inline">Add Block</span>
        </button>
        <button
          type="button"
          onClick={openAddSlot}
          className="hidden min-h-[44px] items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-on-surface hover:bg-surface-secondary sm:flex sm:min-h-0"
          data-testid="add-slot-btn"
        >
          <CalendarClock size={14} />
          Add Slot
        </button>

        <SettingsPopover
          capacityMinutes={settings?.capacity_minutes ?? null}
          workDayStart={workDayStart}
          workDayEnd={workDayEnd}
          timeZone={settings?.time_zone}
          weekStart={settings?.week_start}
        />
      </div>

      <div id={liveRegionId} role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>

      {(error || mutationError) && (
        <div
          role="alert"
          className="border-b border-error/30 bg-error/5 px-4 py-2 text-sm text-error"
          data-testid="timeblocking-error"
        >
          {mutationError ?? error}
          {error && (
            <button type="button" onClick={() => void load()} className="ml-2 underline">
              Retry
            </button>
          )}
        </div>
      )}

      {selectedKey && (selectedBlock || selectedSlot) && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-secondary px-4 py-2 text-xs text-on-surface-muted"
          data-testid="selection-keyboard-bar"
        >
          <span>
            Selected: {selectedBlock?.title ?? selectedSlot?.title}
            {(selectedBlock?.recurrence_rule ||
              selectedBlock?.recurrence_parent_id ||
              selectedSlot?.recurrence_rule ||
              selectedSlot?.recurrence_parent_id) && (
              <span className="ml-1 text-warning">(series)</span>
            )}
          </span>
          <button
            type="button"
            disabled={mutationPending}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface disabled:opacity-50"
            onClick={() => nudgeSelected(-gridInterval)}
          >
            Move earlier
          </button>
          <button
            type="button"
            disabled={mutationPending}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface disabled:opacity-50"
            onClick={() => nudgeSelected(gridInterval)}
          >
            Move later
          </button>
          <button
            type="button"
            disabled={mutationPending}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface disabled:opacity-50"
            onClick={() => nudgeSelected(-gridInterval, "start")}
          >
            Start earlier
          </button>
          <button
            type="button"
            disabled={mutationPending}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface disabled:opacity-50"
            onClick={() => nudgeSelected(gridInterval, "end")}
          >
            End later
          </button>
          <button
            type="button"
            disabled={mutationPending}
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface disabled:opacity-50"
            onClick={() => {
              if (selectedBlock) setEditor(blockToEditorValues(selectedBlock));
              if (selectedSlot) setEditor(slotToEditorValues(selectedSlot));
            }}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={mutationPending}
            className="rounded border border-border px-2 py-1 text-error hover:bg-error/10 disabled:opacity-50"
            onClick={deleteSelected}
          >
            Delete
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-on-surface hover:bg-surface"
            onClick={() => setSelectedKey(null)}
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <div
            className="hidden w-[min(100%,280px)] shrink-0 md:flex"
            data-testid="timeblocking-sidebar-shell"
          >
            <TaskSidebar
              tasks={taskQuery.tasks}
              scheduledTaskIds={scheduledTaskIds}
              onSelectTask={onSelectTask}
              onScheduleTask={scheduleTaskNow}
            />
          </div>
        )}
        <button
          type="button"
          onClick={() => setSidebarCollapsed((value) => !value)}
          className="hidden w-6 shrink-0 items-center justify-center text-on-surface-muted hover:bg-surface-secondary md:flex"
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          data-testid="sidebar-toggle"
        >
          {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>

        {loading && blocks.length === 0 && slots.length === 0 ? (
          <ViewSkeleton />
        ) : (
          <TimelineGrid
            mode={mode}
            rangeFrom={range.from}
            rangeTo={range.to}
            blocks={blocks}
            slots={slots}
            tasksById={tasksById}
            projectsById={projectsById}
            workDayStart={workDayStart}
            workDayEnd={workDayEnd}
            gridInterval={gridInterval}
            defaultDuration={defaultDuration}
            selectedKey={selectedKey}
            mutationPending={mutationPending}
            onSelect={setSelectedKey}
            onOpenBlockEditor={(key) => {
              const block = blocks.find((item) => item.occurrence_key === key);
              if (block) setEditor(blockToEditorValues(block));
            }}
            onOpenSlotEditor={(key) => {
              const slot = slots.find((item) => item.occurrence_key === key);
              if (slot) setEditor(slotToEditorValues(slot));
            }}
            onCreateBlock={handleCreateBlock}
            onMoveBlock={handleMoveBlock}
            onResizeBlock={handleResizeBlock}
            onResizeSlot={handleResizeSlot}
            onToggleTask={(taskId) => void handleToggleTask(taskId)}
            onRemoveSlotTask={handleRemoveSlotTask}
            onReorderSlotTask={handleReorderSlotTask}
            onAppendSlotTask={handleAppendSlotTask}
          />
        )}
      </div>

      <BlockEditorDialog
        open={editor !== null}
        initial={editor}
        tasks={taskQuery.tasks}
        projects={projects}
        slots={slots}
        pending={mutationPending}
        error={mutationError}
        onClose={() => setEditor(null)}
        onSave={handleSaveEditor}
        onDelete={handleDeleteEditor}
      />
    </div>
  );
}
