import { useCallback, useMemo } from "react";
import { Plus, Clock, Repeat, Copy, Clipboard, Edit3, Link, Unlink, Lock, Unlock, Palette, Trash2, ListX } from "lucide-react";
import { createElement } from "react";
import type { TimeBlock, TimeSlot } from "../types.js";
import type { TimeBlockStore } from "../store.js";
import type { ContextMenuItem } from "../../../../ui/components/ContextMenu.js";
import { timeToMinutes, minutesToTime } from "../components/TimelineColumn.js";
import type { ContextMenuState } from "./useTimeblockingState.js";

const BLOCK_COLORS = [
  { name: "Blue", value: "#3b82f6" },
  { name: "Green", value: "#22c55e" },
  { name: "Orange", value: "#f97316" },
  { name: "Purple", value: "#a855f7" },
  { name: "Red", value: "#ef4444" },
  { name: "Default", value: "" },
];

export interface UseTimeblockingContextMenuParams {
  store: TimeBlockStore;
  blocks: TimeBlock[];
  slotsState: TimeSlot[];
  contextMenu: ContextMenuState | null;
  clipboardBlock: TimeBlock | null;
  selectedBlockId: string | null;
  defaultDuration: number;
  workDayEnd: string;
  refreshData: () => void;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  setClipboardBlock: React.Dispatch<React.SetStateAction<TimeBlock | null>>;
  setEditingBlockId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingTitle: React.Dispatch<React.SetStateAction<string>>;
  setSelectedBlockId: React.Dispatch<React.SetStateAction<string | null>>;
  handleBlockCreate: (date: string, startTime: string, endTime: string) => Promise<void>;
  handleSlotCreate: (date: string, startTime: string, endTime: string) => Promise<void>;
  handleDuplicateBlock: (blockId: string) => Promise<void>;
  handleToggleLock: (blockId: string) => Promise<void>;
  handleChangeColor: (blockId: string, color: string) => Promise<void>;
  handleClearSlotTasks: (slotId: string) => Promise<void>;
  handleDeleteSlot: (slotId: string) => Promise<void>;
}

export interface UseTimeblockingContextMenuReturn {
  handleTimelineContextMenu: (e: React.MouseEvent, date: string, time: string) => void;
  handleBlockContextMenu: (e: React.MouseEvent, blockId: string) => void;
  handleSlotContextMenu: (e: React.MouseEvent, slotId: string) => void;
  closeContextMenu: () => void;
  contextMenuItems: ContextMenuItem[];
}

export function useTimeblockingContextMenu(params: UseTimeblockingContextMenuParams): UseTimeblockingContextMenuReturn {
  const {
    store, blocks, slotsState, contextMenu, clipboardBlock, selectedBlockId,
    defaultDuration, workDayEnd,
    refreshData, setContextMenu, setClipboardBlock,
    setEditingBlockId, setEditingTitle, setSelectedBlockId,
    handleBlockCreate, handleSlotCreate, handleDuplicateBlock,
    handleToggleLock, handleChangeColor, handleClearSlotTasks, handleDeleteSlot,
  } = params;

  const handleTimelineContextMenu = useCallback(
    (e: React.MouseEvent, date: string, time: string) => {
      e.preventDefault();
      setContextMenu({ type: "timeline", position: { x: e.clientX, y: e.clientY }, date, time });
    },
    [setContextMenu],
  );

  const handleBlockContextMenu = useCallback(
    (e: React.MouseEvent, blockId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ type: "block", position: { x: e.clientX, y: e.clientY }, targetId: blockId });
    },
    [setContextMenu],
  );

  const handleSlotContextMenu = useCallback(
    (e: React.MouseEvent, slotId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ type: "slot", position: { x: e.clientX, y: e.clientY }, targetId: slotId });
    },
    [setContextMenu],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), [setContextMenu]);

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return [];

    if (contextMenu.type === "timeline") {
      const items: ContextMenuItem[] = [
        {
          id: "new-block",
          label: "New Block",
          icon: createElement(Plus, { size: 14 }),
          shortcut: "Alt+Click",
          onClick: () => {
            if (contextMenu.date && contextMenu.time) {
              const endTime = minutesToTime(Math.min(
                timeToMinutes(contextMenu.time) + defaultDuration,
                timeToMinutes(workDayEnd),
              ));
              handleBlockCreate(contextMenu.date, contextMenu.time, endTime);
            }
          },
        },
        {
          id: "new-recurring-block",
          label: "New Recurring Block",
          icon: createElement(Repeat, { size: 14 }),
          onClick: async () => {
            if (contextMenu.date && contextMenu.time) {
              const endTime = minutesToTime(Math.min(
                timeToMinutes(contextMenu.time) + defaultDuration,
                timeToMinutes(workDayEnd),
              ));
              const block = await store.createBlock({
                title: "New Block",
                date: contextMenu.date,
                startTime: contextMenu.time,
                endTime,
                locked: false,
                recurrenceRule: { frequency: "daily", interval: 1 },
              });
              refreshData();
              setEditingBlockId(block.id);
              setEditingTitle("New Block");
            }
          },
        },
        {
          id: "new-slot",
          label: "New Time Slot",
          icon: createElement(Clock, { size: 14 }),
          shortcut: "Shift+Alt+Click",
          onClick: () => {
            if (contextMenu.date && contextMenu.time) {
              const endTime = minutesToTime(Math.min(
                timeToMinutes(contextMenu.time) + 120,
                timeToMinutes(workDayEnd),
              ));
              handleSlotCreate(contextMenu.date, contextMenu.time, endTime);
            }
          },
        },
      ];

      if (clipboardBlock) {
        items.push({
          id: "paste-block",
          label: "Paste Block",
          icon: createElement(Clipboard, { size: 14 }),
          separator: true,
          onClick: async () => {
            if (contextMenu.date && contextMenu.time) {
              const duration = timeToMinutes(clipboardBlock.endTime) - timeToMinutes(clipboardBlock.startTime);
              const endTime = minutesToTime(Math.min(
                timeToMinutes(contextMenu.time) + duration,
                timeToMinutes(workDayEnd),
              ));
              await store.createBlock({
                title: clipboardBlock.title,
                date: contextMenu.date,
                startTime: contextMenu.time,
                endTime,
                color: clipboardBlock.color,
                locked: false,
                taskId: clipboardBlock.taskId,
              });
              refreshData();
            }
          },
        });
      }

      return items;
    }

    if (contextMenu.type === "block" && contextMenu.targetId) {
      const block = blocks.find((b) => b.id === contextMenu.targetId);
      if (!block) return [];

      return [
        {
          id: "edit-title",
          label: "Edit Title",
          icon: createElement(Edit3, { size: 14 }),
          onClick: () => {
            setEditingBlockId(block.id);
            setEditingTitle(block.title);
          },
        },
        {
          id: "set-recurrence",
          label: "Set Recurrence...",
          icon: createElement(Repeat, { size: 14 }),
          onClick: async () => {
            const rule = block.recurrenceRule
              ? undefined
              : { frequency: "daily" as const, interval: 1 };
            if (rule) {
              await store.updateBlock(block.id, { recurrenceRule: rule });
              refreshData();
            }
          },
        },
        {
          id: "duplicate",
          label: "Duplicate",
          icon: createElement(Copy, { size: 14 }),
          onClick: () => handleDuplicateBlock(block.id),
        },
        {
          id: "copy",
          label: "Copy",
          icon: createElement(Clipboard, { size: 14 }),
          onClick: () => setClipboardBlock(block),
        },
        ...(block.taskId
          ? [{
              id: "unlink-task",
              label: "Unlink Task",
              icon: createElement(Unlink, { size: 14 }),
              separator: true,
              onClick: async () => {
                await store.updateBlock(block.id, { taskId: undefined });
                refreshData();
              },
            }]
          : [{
              id: "link-task",
              label: "Link Task...",
              icon: createElement(Link, { size: 14 }),
              separator: true,
              disabled: true,
              onClick: () => {},
            }]),
        {
          id: "lock-block",
          label: block.locked ? "Unlock Block" : "Lock Block",
          icon: block.locked ? createElement(Unlock, { size: 14 }) : createElement(Lock, { size: 14 }),
          separator: !block.taskId,
          onClick: () => handleToggleLock(block.id),
        },
        {
          id: "change-color",
          label: "Change Color",
          icon: createElement(Palette, { size: 14 }),
          submenu: BLOCK_COLORS.map((c) => ({
            id: `color-${c.name}`,
            label: c.name,
            icon: c.value ? (
              createElement("span", { className: "w-3 h-3 rounded-full inline-block", style: { backgroundColor: c.value } })
            ) : undefined,
            onClick: () => handleChangeColor(block.id, c.value || undefined!),
          })),
        },
        {
          id: "delete",
          label: "Delete",
          icon: createElement(Trash2, { size: 14 }),
          danger: true,
          separator: true,
          onClick: async () => {
            await store.deleteBlock(block.id);
            if (selectedBlockId === block.id) setSelectedBlockId(null);
            refreshData();
          },
        },
      ] as ContextMenuItem[];
    }

    if (contextMenu.type === "slot" && contextMenu.targetId) {
      const slot = slotsState.find((s) => s.id === contextMenu.targetId);
      if (!slot) return [];

      return [
        {
          id: "edit-slot",
          label: "Edit Slot",
          icon: createElement(Edit3, { size: 14 }),
          disabled: true,
          onClick: () => {},
        },
        {
          id: "clear-tasks",
          label: "Clear Tasks",
          icon: createElement(ListX, { size: 14 }),
          disabled: slot.taskIds.length === 0,
          onClick: () => handleClearSlotTasks(slot.id),
        },
        {
          id: "delete-slot",
          label: "Delete Slot",
          icon: createElement(Trash2, { size: 14 }),
          danger: true,
          separator: true,
          onClick: () => handleDeleteSlot(slot.id),
        },
      ];
    }

    return [];
  }, [
    contextMenu, blocks, slotsState, clipboardBlock, defaultDuration, workDayEnd,
    handleBlockCreate, handleSlotCreate, handleDuplicateBlock, handleToggleLock,
    handleChangeColor, handleClearSlotTasks, handleDeleteSlot, selectedBlockId,
    store, refreshData, setEditingBlockId, setEditingTitle, setClipboardBlock, setSelectedBlockId,
  ]);

  return {
    handleTimelineContextMenu,
    handleBlockContextMenu,
    handleSlotContextMenu,
    closeContextMenu,
    contextMenuItems,
  };
}
