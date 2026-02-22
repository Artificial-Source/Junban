import React, { useCallback, useState } from "react";
import {
  DndContext,
  DragOverlay,
  useDroppable,
  useDraggable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Calendar, GripVertical } from "lucide-react";
import type { Task, Project, Section } from "../../core/types.js";
import { getPriority } from "../../core/priorities.js";
import { hexToRgba } from "../../utils/color.js";

interface BoardProps {
  project: Project;
  tasks: Task[];
  sections: Section[];
  onMoveTask: (taskId: string, sectionId: string | null) => void;
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
}

/** Priority value to left-border color class mapping. */
const PRIORITY_BORDER_COLORS: Record<number, string> = {
  1: "border-l-3 border-l-priority-1",
  2: "border-l-3 border-l-priority-2",
  3: "border-l-2 border-l-priority-3",
  4: "",
};

/** A single draggable card representing a task. */
function DraggableCard({
  task,
  onToggle,
  onSelect,
  isSelected,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  isSelected: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  const priority = task.priority ? getPriority(task.priority) : null;
  const priorityBorder = task.priority ? (PRIORITY_BORDER_COLORS[task.priority] ?? "") : "";
  const isOverdue =
    task.dueDate && task.status === "pending" && new Date(task.dueDate) < new Date();
  const priorityCircleColor = task.priority
    ? `border-priority-${task.priority}`
    : "border-on-surface-muted";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group bg-surface rounded-md p-3 border border-border shadow-sm cursor-pointer transition-all duration-150 ${priorityBorder} ${
        isDragging ? "opacity-30" : ""
      } ${isSelected ? "ring-1 ring-accent bg-accent/5" : "hover:shadow-md"}`}
      onClick={() => onSelect(task.id)}
    >
      <div className="flex items-start gap-2">
        {/* Drag handle */}
        <span
          {...attributes}
          {...listeners}
          role="img"
          aria-label="Drag to reorder"
          className="cursor-grab text-on-surface-muted hover:text-on-surface-secondary select-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 mt-0.5 flex-shrink-0"
        >
          <GripVertical size={14} />
        </span>

        {/* Checkbox circle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(task.id);
          }}
          aria-label={
            task.status === "completed"
              ? "Mark task incomplete"
              : `Complete task${priority ? ` (${priority.label})` : ""}`
          }
          className={`w-4 h-4 rounded-full border-2 flex-shrink-0 mt-0.5 transition-all duration-200 ${
            task.status === "completed" ? "bg-success border-success" : priorityCircleColor
          }`}
        />

        {/* Title */}
        <span
          className={`text-sm flex-1 min-w-0 ${
            task.status === "completed" ? "line-through text-on-surface-muted" : "text-on-surface"
          }`}
        >
          {task.title}
        </span>
      </div>

      {/* Metadata row: tags + due date */}
      {(task.tags.length > 0 || task.dueDate) && (
        <div className="flex items-center gap-1.5 mt-2 ml-6 flex-wrap">
          {task.tags.map((tag) => (
            <span
              key={tag.id}
              className={`font-mono text-xs px-1.5 py-0 rounded-md ${
                tag.color ? "" : "bg-surface-tertiary text-on-surface-secondary"
              }`}
              style={
                tag.color
                  ? { backgroundColor: hexToRgba(tag.color, 0.15), color: tag.color }
                  : undefined
              }
            >
              {tag.name}
            </span>
          ))}
          {task.dueDate && (
            <span
              className={`text-xs flex items-center gap-1 flex-shrink-0 ${
                isOverdue ? "text-error font-medium" : "text-on-surface-muted"
              }`}
            >
              <Calendar size={11} />
              {new Date(task.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** A droppable column representing a section (or "no section"). */
function BoardColumn({
  columnId,
  title,
  tasks,
  onToggle,
  onSelect,
  selectedTaskId,
}: {
  columnId: string;
  title: string;
  tasks: Task[];
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });

  return (
    <div
      ref={setNodeRef}
      className={`min-w-[280px] max-w-[320px] bg-surface-secondary rounded-lg p-3 flex flex-col flex-shrink-0 transition-colors duration-150 ${
        isOver ? "ring-2 ring-accent/50 bg-accent/5" : ""
      }`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-sm font-semibold text-on-surface">{title}</h3>
        <span className="text-xs text-on-surface-muted bg-surface-tertiary px-1.5 py-0.5 rounded-full">
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2 flex-1 min-h-[60px]">
        {tasks.map((task) => (
          <DraggableCard
            key={task.id}
            task={task}
            onToggle={onToggle}
            onSelect={onSelect}
            isSelected={selectedTaskId === task.id}
          />
        ))}
        {tasks.length === 0 && (
          <div className="text-xs text-on-surface-muted text-center py-4 border-2 border-dashed border-border/50 rounded-md">
            Drop tasks here
          </div>
        )}
      </div>
    </div>
  );
}

/** Card rendered inside the drag overlay (floating ghost). */
function DragOverlayCard({ task }: { task: Task }) {
  const priorityBorder = task.priority ? (PRIORITY_BORDER_COLORS[task.priority] ?? "") : "";

  return (
    <div
      className={`bg-surface rounded-md p-3 border border-accent/30 shadow-lg rotate-2 opacity-90 min-w-[260px] ${priorityBorder}`}
    >
      <div className="flex items-start gap-2">
        <span className="text-on-surface-muted mt-0.5">
          <GripVertical size={14} />
        </span>
        <span className="text-sm text-on-surface">{task.title}</span>
      </div>
    </div>
  );
}

/** Kanban board view: columns = sections within a project. */
export function Board({
  project: _project,
  tasks,
  sections,
  onMoveTask,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
}: BoardProps) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const sortedSections = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);

  // Group tasks by sectionId
  const noSectionTasks = tasks.filter((t) => t.sectionId === null);
  const tasksBySection = new Map<string, Task[]>();
  for (const section of sortedSections) {
    tasksBySection.set(
      section.id,
      tasks.filter((t) => t.sectionId === section.id),
    );
  }

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const targetColumnId = over.id as string;

      // Determine the new sectionId (null for "no-section" column)
      const newSectionId = targetColumnId === "__no_section__" ? null : targetColumnId;

      // Find the task's current sectionId
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      // Only call onMoveTask if the section actually changed
      if (task.sectionId !== newSectionId) {
        onMoveTask(taskId, newSectionId);
      }
    },
    [tasks, onMoveTask],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  const activeDragTask = activeDragId ? tasks.find((t) => t.id === activeDragId) : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-4 overflow-x-auto pb-4 -mx-2 px-2">
        {/* "No section" column */}
        <BoardColumn
          columnId="__no_section__"
          title="No section"
          tasks={noSectionTasks}
          onToggle={onToggleTask}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
        />

        {/* One column per section */}
        {sortedSections.map((section) => (
          <BoardColumn
            key={section.id}
            columnId={section.id}
            title={section.name}
            tasks={tasksBySection.get(section.id) ?? []}
            onToggle={onToggleTask}
            onSelect={onSelectTask}
            selectedTaskId={selectedTaskId}
          />
        ))}
      </div>

      <DragOverlay>{activeDragTask ? <DragOverlayCard task={activeDragTask} /> : null}</DragOverlay>
    </DndContext>
  );
}
