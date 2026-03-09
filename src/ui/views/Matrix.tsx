import React, { useCallback, useState, useMemo } from "react";
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
import { GripVertical } from "lucide-react";
import { toDateKey } from "../../utils/format-date.js";
import type { Task } from "../../core/types.js";

interface MatrixProps {
  tasks: Task[];
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  onUpdateTask: (id: string, updates: Record<string, unknown>) => void;
  selectedTaskId: string | null;
}

type Quadrant = "q1" | "q2" | "q3" | "q4";

interface QuadrantConfig {
  id: Quadrant;
  title: string;
  subtitle: string;
  bgClass: string;
  borderClass: string;
}

const QUADRANTS: QuadrantConfig[] = [
  {
    id: "q1",
    title: "Do First",
    subtitle: "Urgent + Important",
    bgClass: "bg-error/5",
    borderClass: "border-error/20",
  },
  {
    id: "q2",
    title: "Schedule",
    subtitle: "Important",
    bgClass: "bg-accent/5",
    borderClass: "border-accent/20",
  },
  {
    id: "q3",
    title: "Delegate",
    subtitle: "Urgent",
    bgClass: "bg-warning/5",
    borderClass: "border-warning/20",
  },
  {
    id: "q4",
    title: "Eliminate",
    subtitle: "Neither",
    bgClass: "bg-surface-secondary",
    borderClass: "border-border",
  },
];

function classifyTask(task: Task, today: string): Quadrant {
  const isHighPriority =
    task.priority !== null && task.priority !== undefined && task.priority <= 2;
  const isUrgent =
    task.dueDate !== null && task.dueDate !== undefined && task.dueDate.split("T")[0] <= today;

  if (isHighPriority && isUrgent) return "q1";
  if (isHighPriority) return "q2";
  if (isUrgent) return "q3";
  return "q4";
}

function DraggableTaskCard({
  task,
  onSelect,
  isSelected,
}: {
  task: Task;
  onSelect: (id: string) => void;
  isSelected: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-2 bg-surface rounded-md px-2.5 py-1.5 border border-border text-sm cursor-pointer transition-all ${
        isDragging ? "opacity-30" : ""
      } ${isSelected ? "ring-1 ring-accent bg-accent/5" : "hover:shadow-sm"}`}
      onClick={() => onSelect(task.id)}
    >
      <span
        {...attributes}
        {...listeners}
        role="img"
        aria-label="Drag to reorder"
        className="cursor-grab text-on-surface-muted hover:text-on-surface-secondary opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
      >
        <GripVertical size={14} />
      </span>
      <span className="text-on-surface truncate flex-1">{task.title}</span>
      {task.priority && task.priority <= 2 && (
        <span className="text-[10px] px-1 rounded bg-error/10 text-error flex-shrink-0">
          P{task.priority}
        </span>
      )}
    </div>
  );
}

function DroppableQuadrant({
  config,
  tasks,
  onSelect,
  selectedTaskId,
}: {
  config: QuadrantConfig;
  tasks: Task[];
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: config.id });

  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border p-3 flex flex-col min-h-[200px] transition-colors ${config.bgClass} ${config.borderClass} ${
        isOver ? "ring-2 ring-accent" : ""
      }`}
    >
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-on-surface">{config.title}</h3>
        <p className="text-xs text-on-surface-muted">{config.subtitle}</p>
      </div>
      <div className="flex-1 space-y-1.5 overflow-auto">
        {tasks.map((task) => (
          <DraggableTaskCard
            key={task.id}
            task={task}
            onSelect={onSelect}
            isSelected={selectedTaskId === task.id}
          />
        ))}
        {tasks.length === 0 && (
          <p className="text-xs text-on-surface-muted/50 text-center py-4">Drop tasks here</p>
        )}
      </div>
      <div className="mt-2 text-xs text-on-surface-muted text-right">
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
      </div>
    </div>
  );
}

export function Matrix({
  tasks,
  onToggleTask: _onToggleTask,
  onSelectTask,
  onUpdateTask,
  selectedTaskId,
}: MatrixProps) {
  const today = toDateKey(new Date());
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const pendingTasks = useMemo(() => tasks.filter((t) => t.status === "pending"), [tasks]);

  const quadrantTasks = useMemo(() => {
    const map: Record<Quadrant, Task[]> = { q1: [], q2: [], q3: [], q4: [] };
    for (const task of pendingTasks) {
      const q = classifyTask(task, today);
      map[q].push(task);
    }
    return map;
  }, [pendingTasks, today]);

  const draggedTask = draggedTaskId
    ? (pendingTasks.find((t) => t.id === draggedTaskId) ?? null)
    : null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggedTaskId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedTaskId(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const targetQuadrant = over.id as Quadrant;
      const task = pendingTasks.find((t) => t.id === taskId);
      if (!task) return;

      const currentQuadrant = classifyTask(task, today);
      if (currentQuadrant === targetQuadrant) return;

      const todayISO = new Date().toISOString();
      const updates: Record<string, unknown> = {};

      switch (targetQuadrant) {
        case "q1":
          updates.priority = 1;
          updates.dueDate = todayISO;
          break;
        case "q2":
          updates.priority = 1;
          updates.dueDate = null;
          break;
        case "q3":
          updates.priority = 3;
          updates.dueDate = todayISO;
          break;
        case "q4":
          updates.priority = 3;
          updates.dueDate = null;
          break;
      }

      onUpdateTask(taskId, updates);
    },
    [pendingTasks, today, onUpdateTask],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4 md:mb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-on-surface">Matrix</h1>
        <span className="text-sm text-on-surface-muted">
          {pendingTasks.length} {pendingTasks.length === 1 ? "task" : "tasks"}
        </span>
      </div>

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
          {QUADRANTS.map((config) => (
            <DroppableQuadrant
              key={config.id}
              config={config}
              tasks={quadrantTasks[config.id]}
              onSelect={onSelectTask}
              selectedTaskId={selectedTaskId}
            />
          ))}
        </div>
        <DragOverlay>
          {draggedTask && (
            <div className="bg-surface rounded-md px-2.5 py-1.5 border border-accent shadow-lg text-sm text-on-surface">
              {draggedTask.title}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
