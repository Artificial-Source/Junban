/**
 * Pending-task sidebar for scheduling onto the timeline or into slots.
 */
import { AlertCircle, Calendar, ChevronDown, ChevronRight, Clock, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import type { TaskDto } from "../../api/client";
import { calendarDayKey, todayKey } from "../../lib/dates";

interface TaskSidebarProps {
  tasks: TaskDto[];
  scheduledTaskIds: Set<string>;
  onSelectTask?: (taskId: string) => void;
  onScheduleTask?: (taskId: string) => void;
}

const PRIORITY_DOT: Record<number, string> = {
  1: "bg-priority-1",
  2: "bg-priority-2",
  3: "bg-priority-3",
};

function formatSidebarDate(value: string): string {
  const day = calendarDayKey(value);
  if (day === null) return value;
  return new Date(`${day}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function groupTasks(tasks: TaskDto[], today: string) {
  const overdue: TaskDto[] = [];
  const todayTasks: TaskDto[] = [];
  const unscheduled: TaskDto[] = [];
  for (const task of tasks) {
    if (task.status !== "pending") continue;
    if (task.due_date && task.due_date < today) {
      overdue.push(task);
    } else if (task.due_date === today) {
      todayTasks.push(task);
    } else {
      unscheduled.push(task);
    }
  }
  const byPriority = (left: TaskDto, right: TaskDto) =>
    (left.priority ?? 4) - (right.priority ?? 4);
  overdue.sort(byPriority);
  todayTasks.sort(byPriority);
  unscheduled.sort(byPriority);
  return { overdue, todayTasks, unscheduled };
}

function SidebarTask({
  task,
  isScheduled,
  onSelectTask,
  onScheduleTask,
}: {
  task: TaskDto;
  isScheduled: boolean;
  onSelectTask?: (taskId: string) => void;
  onScheduleTask?: (taskId: string) => void;
}) {
  return (
    <div
      draggable
      data-testid={`sidebar-task-${task.id}`}
      className="rounded-md border border-border bg-surface p-2 cursor-grab select-none hover:shadow-sm hover:border-accent-action/30"
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-junban-task-id", task.id);
        event.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={() => onSelectTask?.(task.id)}
    >
      <div className="flex items-center gap-2 min-w-0">
        {task.priority && task.priority <= 3 && (
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority]}`} />
        )}
        <span className="text-sm text-on-surface truncate flex-1">{task.title}</span>
        {isScheduled && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-action/15 text-accent-foreground flex-shrink-0">
            scheduled
          </span>
        )}
      </div>
      {(task.due_date || task.estimated_minutes) && (
        <div className="flex items-center gap-2 mt-1 text-xs text-on-surface-muted">
          {task.due_date && (
            <span className="flex items-center gap-0.5">
              <Calendar size={10} aria-hidden />
              {formatSidebarDate(task.due_date)}
            </span>
          )}
          {task.estimated_minutes != null && <span>{task.estimated_minutes}m</span>}
        </div>
      )}
      {onScheduleTask && (
        <button
          type="button"
          className="sr-only"
          onClick={(event) => {
            event.stopPropagation();
            onScheduleTask(task.id);
          }}
        >
          Add {task.title} to the schedule
        </button>
      )}
    </div>
  );
}

function TaskGroup({
  label,
  icon,
  accentClass,
  tasks,
  scheduledTaskIds,
  defaultOpen = true,
  onSelectTask,
  onScheduleTask,
}: {
  label: string;
  icon: React.ReactNode;
  accentClass?: string;
  tasks: TaskDto[];
  scheduledTaskIds: Set<string>;
  defaultOpen?: boolean;
  onSelectTask?: (taskId: string) => void;
  onScheduleTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (tasks.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-1 py-1 text-xs font-medium text-on-surface-secondary hover:text-on-surface"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        <span className={accentClass}>{label}</span>
        <span className="ml-auto text-on-surface-muted">{tasks.length}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1.5">
          {tasks.map((task) => (
            <SidebarTask
              key={task.id}
              task={task}
              isScheduled={scheduledTaskIds.has(task.id)}
              onSelectTask={onSelectTask}
              onScheduleTask={onScheduleTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskSidebar({
  tasks,
  scheduledTaskIds,
  onSelectTask,
  onScheduleTask,
}: TaskSidebarProps) {
  const today = todayKey();
  const groups = useMemo(() => groupTasks(tasks, today), [tasks, today]);

  return (
    <aside
      className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-border bg-surface-secondary"
      data-testid="timeblocking-task-sidebar"
    >
      <div className="border-b border-border px-3 py-3">
        <h2 className="text-sm font-semibold text-on-surface">Tasks</h2>
        <p className="mt-0.5 text-xs text-on-surface-muted">Drag to schedule</p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-2">
        <TaskGroup
          label="Overdue"
          icon={<AlertCircle size={12} className="text-error" />}
          accentClass="text-error"
          tasks={groups.overdue}
          scheduledTaskIds={scheduledTaskIds}
          onSelectTask={onSelectTask}
          onScheduleTask={onScheduleTask}
        />
        <TaskGroup
          label="Today"
          icon={<Clock size={12} />}
          tasks={groups.todayTasks}
          scheduledTaskIds={scheduledTaskIds}
          onSelectTask={onSelectTask}
          onScheduleTask={onScheduleTask}
        />
        <TaskGroup
          label="Unscheduled"
          icon={<Inbox size={12} />}
          tasks={groups.unscheduled}
          scheduledTaskIds={scheduledTaskIds}
          defaultOpen={groups.overdue.length === 0 && groups.todayTasks.length === 0}
          onSelectTask={onSelectTask}
          onScheduleTask={onScheduleTask}
        />
        {groups.overdue.length === 0 &&
          groups.todayTasks.length === 0 &&
          groups.unscheduled.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-on-surface-muted">
              No pending tasks to schedule.
            </p>
          )}
      </div>
    </aside>
  );
}
