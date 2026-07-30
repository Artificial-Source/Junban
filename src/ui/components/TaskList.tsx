/**
 * Phase 2 TaskList with multiselect support and optional drag-and-drop reorder.
 */
import { useState, useRef, useCallback, useMemo } from "react";
import { ClipboardList } from "lucide-react";
import type { TaskDto, TagDto } from "../api/client";
import { depthsFromParentGraph } from "../lib/taskHierarchy";
import { TaskItem } from "./TaskItem";
import { EmptyState } from "./Skeleton";

interface TaskListProps {
  tasks: TaskDto[];
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    orderedIds: string[],
  ) => void;
  emptyMessage: string;
  emptyDescription?: string;
  todayKey: string;
  projectName?: (taskId: string) => string | null;
  projectColor?: (taskId: string) => string | null;
  tagMap?: Map<string, TagDto>;
  onReorder?: (orderedIds: string[]) => Promise<boolean>;
  onIndent?: (id: string) => Promise<boolean>;
  onOutdent?: (id: string) => Promise<boolean>;
}

export function TaskList({
  tasks,
  onToggle,
  onSelect,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  emptyMessage,
  emptyDescription,
  todayKey,
  projectName,
  projectColor,
  tagMap,
  onReorder,
  onIndent,
  onOutdent,
}: TaskListProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOverIdRef = useRef<string | null>(null);

  const handleDragStart = useCallback((id: string) => {
    setDraggingId(id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    dragOverIdRef.current = id;
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const draggingIdCopy = draggingId;
      const overId = dragOverIdRef.current;
      setDraggingId(null);
      dragOverIdRef.current = null;
      if (!draggingIdCopy || !overId || draggingIdCopy === overId || !onReorder) return;

      const ids = tasks.map((t) => t.id);
      const fromIdx = ids.indexOf(draggingIdCopy);
      const toIdx = ids.indexOf(overId);
      if (fromIdx === -1 || toIdx === -1) return;

      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, draggingIdCopy);
      void onReorder(ids);
    },
    [draggingId, tasks, onReorder],
  );

  /** Keyboard path for the same sibling permutation as pointer reorder. */
  const handleKeyboardMove = useCallback(
    (id: string, direction: "up" | "down") => {
      if (!onReorder) return;
      const ids = tasks.map((t) => t.id);
      const fromIdx = ids.indexOf(id);
      if (fromIdx === -1) return;
      const toIdx = direction === "up" ? fromIdx - 1 : fromIdx + 1;
      if (toIdx < 0 || toIdx >= ids.length) return;
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, id);
      void onReorder(ids);
    },
    [tasks, onReorder],
  );

  const orderedIds = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const depthById = useMemo(() => depthsFromParentGraph(tasks), [tasks]);

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList size={40} strokeWidth={1.25} />}
        title={emptyMessage}
        description={emptyDescription}
      />
    );
  }

  const handleItemMultiSelect = onMultiSelect
    ? (id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
        onMultiSelect(id, event, orderedIds)
    : undefined;

  return (
    <ul aria-label="Tasks" className="space-y-0" onDragOver={(e) => e.preventDefault()}>
      {tasks.map((task) => (
        <li
          key={task.id}
          onDragOver={(e) => handleDragOver(e, task.id)}
          onDrop={handleDrop}
          className={draggingId === task.id ? "opacity-30" : ""}
        >
          <TaskItem
            task={task}
            onToggle={onToggle}
            onSelect={onSelect}
            isSelected={selectedTaskId === task.id}
            isMultiSelected={selectedTaskIds?.has(task.id) ?? false}
            onMultiSelect={handleItemMultiSelect}
            todayKey={todayKey}
            projectName={projectName?.(task.id)}
            projectColor={projectColor?.(task.id)}
            tagMap={tagMap}
            depth={depthById.get(task.id) ?? 0}
            onIndent={onIndent}
            onOutdent={onOutdent}
            onMove={onReorder ? handleKeyboardMove : undefined}
            showDragHandle={!!onReorder || !!(onIndent || onOutdent)}
            onDragStart={onReorder ? handleDragStart : undefined}
          />
        </li>
      ))}
    </ul>
  );
}
