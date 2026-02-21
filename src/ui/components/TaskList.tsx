import React, { useCallback, useState } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ClipboardList } from "lucide-react";
import type { Task } from "../../core/types.js";
import { TaskItem } from "./TaskItem.js";
import { InlineAddSubtask } from "./InlineAddSubtask.js";
import { EmptyState } from "./EmptyState.js";

interface ChildStats {
  children: Task[];
  completed: number;
  total: number;
}

interface TaskListProps {
  tasks: Task[];
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
  emptyMessage?: string;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  onReorder?: (orderedIds: string[]) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
}

const SortableTaskItem = React.memo(function SortableTaskItem({
  task,
  onToggle,
  onSelect,
  isSelected,
  isMultiSelected,
  showCheckbox,
  onMultiSelect,
  depth,
  completedChildCount,
  totalChildCount,
  expanded,
  onToggleExpand,
  onUpdateDueDate,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  isSelected: boolean;
  isMultiSelected: boolean;
  showCheckbox: boolean;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  depth?: number;
  completedChildCount?: number;
  totalChildCount?: number;
  expanded?: boolean;
  onToggleExpand?: (id: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: task.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <TaskItem
      task={task}
      onToggle={onToggle}
      onSelect={onSelect}
      isSelected={isSelected}
      isMultiSelected={isMultiSelected}
      showCheckbox={showCheckbox}
      onMultiSelect={onMultiSelect}
      dragHandleProps={{ ...attributes, ...listeners }}
      style={style}
      innerRef={setNodeRef}
      depth={depth}
      completedChildCount={completedChildCount}
      totalChildCount={totalChildCount}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      onUpdateDueDate={onUpdateDueDate}
    />
  );
});

/** Build a parent -> children stats map from a flat task list. */
function buildChildStats(tasks: Task[]): Map<string, ChildStats> {
  const map = new Map<string, ChildStats>();
  for (const t of tasks) {
    if (t.parentId) {
      if (!map.has(t.parentId)) map.set(t.parentId, { children: [], completed: 0, total: 0 });
      const stats = map.get(t.parentId)!;
      stats.children.push(t);
      stats.total++;
      if (t.status === "completed") stats.completed++;
    }
  }
  return map;
}

export function TaskList({
  tasks,
  onToggle,
  onSelect,
  selectedTaskId,
  emptyMessage,
  selectedTaskIds,
  onMultiSelect,
  onReorder,
  onAddSubtask,
  onUpdateDueDate,
}: TaskListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id || !onReorder) return;

      const oldIndex = tasks.findIndex((t) => t.id === active.id);
      const newIndex = tasks.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...tasks];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      onReorder(reordered.map((t) => t.id));
    },
    [tasks, onReorder],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList size={40} strokeWidth={1.25} />}
        title={emptyMessage ?? "No tasks yet. Add one above!"}
      />
    );
  }

  // Build tree structure from flat list
  const childStatsMap = buildChildStats(tasks);
  const topLevel = tasks.filter((t) => !t.parentId);

  // Flatten visible tree for DnD ordering
  function flattenVisible(
    items: Task[],
    depth: number,
  ): Array<{ task: Task; depth: number; showAddSubtask?: boolean }> {
    const result: Array<{ task: Task; depth: number; showAddSubtask?: boolean }> = [];
    for (const item of items) {
      const stats = childStatsMap.get(item.id);
      result.push({ task: item, depth });
      if (stats && expandedIds.has(item.id)) {
        result.push(...flattenVisible(stats.children, depth + 1));
        // Mark last child to show inline add subtask
        if (onAddSubtask) {
          result.push({ task: item, depth: depth + 1, showAddSubtask: true });
        }
      }
    }
    return result;
  }

  const visibleTasks = flattenVisible(topLevel, 0);
  const isMultiSelectActive = selectedTaskIds && selectedTaskIds.size > 0;
  const taskIds = visibleTasks.filter((v) => !v.showAddSubtask).map((v) => v.task.id);

  const activeDragTask = activeDragId ? tasks.find((t) => t.id === activeDragId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div role="list" aria-label="Tasks" className="space-y-0">
          {visibleTasks.map((entry) => {
            if (entry.showAddSubtask) {
              return (
                <InlineAddSubtask
                  key={`add-subtask-${entry.task.id}`}
                  parentId={entry.task.id}
                  depth={entry.depth}
                  onAdd={onAddSubtask!}
                />
              );
            }

            const { task, depth } = entry;
            const stats = childStatsMap.get(task.id);
            return (
              <SortableTaskItem
                key={task.id}
                task={task}
                onToggle={onToggle}
                onSelect={onSelect}
                isSelected={selectedTaskId === task.id}
                isMultiSelected={selectedTaskIds?.has(task.id) ?? false}
                showCheckbox={!!isMultiSelectActive}
                onMultiSelect={onMultiSelect}
                depth={depth}
                completedChildCount={stats?.completed ?? 0}
                totalChildCount={stats?.total ?? 0}
                expanded={expandedIds.has(task.id)}
                onToggleExpand={handleToggleExpand}
                onUpdateDueDate={onUpdateDueDate}
              />
            );
          })}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeDragTask ? (
          <div className="opacity-80 shadow-lg rounded-lg rotate-1 bg-surface border border-accent/30">
            <TaskItem
              task={activeDragTask}
              onToggle={() => {}}
              onSelect={() => {}}
              isSelected={false}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
