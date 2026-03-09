import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Calendar, ChevronDown, ChevronRight, AlertCircle, Clock, Inbox } from "lucide-react";
import type { Task } from "../../../../core/types.js";

interface TaskSidebarProps {
  tasks: Task[];
  scheduledTaskIds: Set<string>;
  groups?: {
    overdue: Task[];
    today: Task[];
    unscheduled: Task[];
  };
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "bg-priority-1",
  2: "bg-priority-2",
  3: "bg-priority-3",
};

function DraggableTask({
  task,
  isScheduled,
}: {
  task: Task;
  isScheduled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: task.id,
      data: { type: "task", task },
    });

  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`p-2 rounded-md border border-border bg-surface cursor-grab select-none transition-all duration-150 ${
        isDragging ? "opacity-30" : "hover:shadow-sm hover:border-accent/30"
      }`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-center gap-2 min-w-0">
        {task.priority && task.priority <= 3 && (
          <div
            className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_COLORS[task.priority]}`}
          />
        )}
        <span className="text-sm text-on-surface truncate flex-1">
          {task.title}
        </span>
        {isScheduled && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent flex-shrink-0">
            scheduled
          </span>
        )}
      </div>

      {(task.dueDate || task.estimatedMinutes) && (
        <div className="flex items-center gap-2 mt-1 text-xs text-on-surface-muted">
          {task.dueDate && (
            <span className="flex items-center gap-0.5">
              <Calendar size={10} />
              {new Date(task.dueDate + "T00:00:00").toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </span>
          )}
          {task.estimatedMinutes && (
            <span>{task.estimatedMinutes}m</span>
          )}
        </div>
      )}
    </div>
  );
}

function TaskGroup({
  label,
  icon,
  tasks,
  scheduledTaskIds,
  defaultOpen = true,
  accentClass,
}: {
  label: string;
  icon: React.ReactNode;
  tasks: Task[];
  scheduledTaskIds: Set<string>;
  defaultOpen?: boolean;
  accentClass?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (tasks.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-1 py-1 text-xs font-medium text-on-surface-secondary hover:text-on-surface transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        <span className={accentClass}>{label}</span>
        <span className="ml-auto text-on-surface-muted">{tasks.length}</span>
      </button>
      {open && (
        <div className="space-y-1.5 mt-1">
          {tasks.map((task) => (
            <DraggableTask
              key={task.id}
              task={task}
              isScheduled={scheduledTaskIds.has(task.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskSidebar({ tasks, scheduledTaskIds, groups }: TaskSidebarProps) {
  const pendingTasks = tasks.filter((t) => t.status === "pending");

  return (
    <div className="w-full flex-shrink-0 border-r border-border bg-surface-secondary flex flex-col overflow-hidden">
      <div className="px-3 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-on-surface">Tasks</h3>
        <p className="text-xs text-on-surface-muted mt-0.5">
          Drag to schedule
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {groups ? (
          <>
            <TaskGroup
              label="Overdue"
              icon={<AlertCircle size={12} className="text-error" />}
              tasks={groups.overdue}
              scheduledTaskIds={scheduledTaskIds}
              accentClass="text-error"
            />
            <TaskGroup
              label="Today"
              icon={<Clock size={12} />}
              tasks={groups.today}
              scheduledTaskIds={scheduledTaskIds}
            />
            <TaskGroup
              label="Unscheduled"
              icon={<Inbox size={12} />}
              tasks={groups.unscheduled}
              scheduledTaskIds={scheduledTaskIds}
            />
          </>
        ) : (
          <>
            {pendingTasks.length === 0 && (
              <p className="text-xs text-on-surface-muted text-center py-4">
                No pending tasks
              </p>
            )}
            {pendingTasks.map((task) => (
              <DraggableTask
                key={task.id}
                task={task}
                isScheduled={scheduledTaskIds.has(task.id)}
              />
            ))}
          </>
        )}
        {groups &&
          groups.overdue.length === 0 &&
          groups.today.length === 0 &&
          groups.unscheduled.length === 0 && (
            <p className="text-xs text-on-surface-muted text-center py-4">
              No pending tasks
            </p>
          )}
      </div>
    </div>
  );
}
