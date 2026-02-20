import { useState, useRef, useCallback, useMemo } from "react";
import { Plus, ChevronDown } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Task } from "../../core/types.js";
import { SortableSubtaskBlock } from "./SubtaskBlock.js";

interface SubtaskSectionProps {
  task: Task;
  allTasks: Task[];
  editingSubtaskId: string | null;
  editingSubtaskTitle: string;
  focusedSubtaskIdx: number;
  onEditTitleChange: (val: string) => void;
  onStartEdit: (child: Task) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggle?: (id: string) => void;
  onSelect?: (id: string) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onFocusedIdxChange: (idx: number) => void;
}

export function SubtaskSection({
  task,
  allTasks,
  editingSubtaskId,
  editingSubtaskTitle,
  focusedSubtaskIdx,
  onEditTitleChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggle,
  onSelect,
  onAddSubtask,
  onReorder,
  onFocusedIdxChange,
}: SubtaskSectionProps) {
  const [subtasksExpanded, setSubtasksExpanded] = useState(true);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const subtaskInputRef = useRef<HTMLInputElement>(null);
  const [localChildOrder, setLocalChildOrder] = useState<string[] | null>(null);

  // Reset local state when task changes
  const [trackedTaskId, setTrackedTaskId] = useState(task.id);
  if (task.id !== trackedTaskId) {
    setTrackedTaskId(task.id);
    setSubtasksExpanded(true);
    setAddingSubtask(false);
    setSubtaskTitle("");
    setLocalChildOrder(null);
  }

  const subtaskSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const children = useMemo(
    () => allTasks.filter((t) => t.parentId === task.id),
    [allTasks, task.id],
  );

  const orderedChildren = useMemo(() => {
    if (!localChildOrder) return children;
    const childMap = new Map(children.map((c) => [c.id, c]));
    const ordered = localChildOrder
      .map((id) => childMap.get(id))
      .filter((c): c is Task => c !== undefined);
    for (const child of children) {
      if (!localChildOrder.includes(child.id)) {
        ordered.push(child);
      }
    }
    return ordered;
  }, [localChildOrder, children]);

  const handleSubtaskDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const currentIds = localChildOrder ?? children.map((c) => c.id);
      const oldIndex = currentIds.indexOf(active.id as string);
      const newIndex = currentIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...currentIds];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      setLocalChildOrder(reordered);
      onReorder?.(reordered);
    },
    [children, localChildOrder, onReorder],
  );

  const handleSubtaskKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (orderedChildren.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        onFocusedIdxChange(Math.min(focusedSubtaskIdx + 1, orderedChildren.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onFocusedIdxChange(Math.max(focusedSubtaskIdx - 1, 0));
      } else if (
        e.key === "Enter" &&
        focusedSubtaskIdx >= 0 &&
        focusedSubtaskIdx < orderedChildren.length
      ) {
        e.preventDefault();
        onStartEdit(orderedChildren[focusedSubtaskIdx]);
      }
    },
    [orderedChildren, focusedSubtaskIdx, onStartEdit, onFocusedIdxChange],
  );

  const handleAddSubtask = () => {
    const trimmed = subtaskTitle.trim();
    if (trimmed && onAddSubtask) {
      onAddSubtask(task.id, trimmed);
      setSubtaskTitle("");
      setTimeout(() => subtaskInputRef.current?.focus(), 0);
    }
  };

  const completedCount = orderedChildren.filter((c) => c.status === "completed").length;
  const progressPercent =
    orderedChildren.length > 0 ? (completedCount / orderedChildren.length) * 100 : 0;

  if (orderedChildren.length === 0 && !onAddSubtask) return null;

  return (
    <div className="pt-2">
      {/* Section header */}
      <div className="flex items-center justify-between px-2">
        <button
          onClick={() => setSubtasksExpanded((prev) => !prev)}
          className="flex items-center gap-2 text-xs font-medium text-on-surface-muted uppercase tracking-wider hover:text-on-surface transition-colors"
        >
          <ChevronDown
            size={14}
            className={`transition-transform duration-200 ${subtasksExpanded ? "" : "-rotate-90"}`}
          />
          Sub-tasks
          {orderedChildren.length > 0 && (
            <span className="text-on-surface-muted/70 normal-case tracking-normal">
              {completedCount}/{orderedChildren.length}
            </span>
          )}
        </button>
        {onAddSubtask && (
          <button
            onClick={() => {
              setAddingSubtask(true);
              setSubtasksExpanded(true);
              setTimeout(() => subtaskInputRef.current?.focus(), 0);
            }}
            className="p-1 rounded text-on-surface-muted hover:text-accent hover:bg-accent/10 transition-colors"
            title="Add sub-task"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {/* Progress bar */}
      {orderedChildren.length > 0 && (
        <div className="mx-2 mt-1.5 mb-2 h-1 bg-surface-tertiary rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      {/* Collapsible content */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: subtasksExpanded ? "1fr" : "0fr" }}
      >
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div className="overflow-hidden" onKeyDown={handleSubtaskKeyDown} tabIndex={-1}>
          <DndContext
            sensors={subtaskSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleSubtaskDragEnd}
          >
            <SortableContext
              items={orderedChildren.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {orderedChildren.map((child, idx) => (
                <SortableSubtaskBlock
                  key={child.id}
                  task={child}
                  isEditing={editingSubtaskId === child.id}
                  editTitle={editingSubtaskTitle}
                  isFocused={focusedSubtaskIdx === idx}
                  onEditTitleChange={onEditTitleChange}
                  onStartEdit={() => onStartEdit(child)}
                  onSaveEdit={onSaveEdit}
                  onCancelEdit={onCancelEdit}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Inline add subtask — rapid entry */}
          {onAddSubtask &&
            (addingSubtask ? (
              <div className="flex items-center gap-2 px-2 py-1.5">
                {/* Spacer for drag handle alignment */}
                <span className="w-[14px] flex-shrink-0" />
                <div className="w-4 h-4 rounded-full border-2 border-dashed border-on-surface-muted/40 flex-shrink-0" />
                <input
                  ref={subtaskInputRef}
                  type="text"
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddSubtask();
                    if (e.key === "Escape") {
                      setSubtaskTitle("");
                      setAddingSubtask(false);
                    }
                  }}
                  onBlur={() => {
                    if (!subtaskTitle.trim()) setAddingSubtask(false);
                    else handleAddSubtask();
                  }}
                  placeholder="Add a sub-task..."
                  autoFocus
                  className="flex-1 text-sm bg-transparent border-none outline-none text-on-surface placeholder-on-surface-muted/50"
                />
              </div>
            ) : !subtasksExpanded ? null : (
              <button
                onClick={() => {
                  setAddingSubtask(true);
                  setTimeout(() => subtaskInputRef.current?.focus(), 0);
                }}
                className="flex items-center gap-2 px-2 py-1.5 text-sm text-on-surface-muted hover:text-accent transition-colors w-full text-left"
              >
                <span className="w-[14px] flex-shrink-0" />
                <Plus size={14} />
                Add sub-task
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
