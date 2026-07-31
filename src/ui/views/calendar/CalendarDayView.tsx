import { useMemo } from "react";
import { CalendarOff } from "lucide-react";
import type { ProjectDto, TagDto, TaskDto } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { CalendarTaskCard } from "./CalendarTaskCard";
import {
  formatCivilTime,
  groupTasksByDueDate,
  splitDayTasks,
  toCivilDateKey,
} from "./calendarRange";

interface CalendarDayViewProps {
  selectedDate: Date;
  tasks: TaskDto[];
  projects: ProjectDto[];
  tags: TagDto[];
  onSelectTask: (id: string) => void;
  onToggleTask: (id: string) => Promise<boolean>;
  onDragStart?: (taskId: string) => void;
}

export function CalendarDayView({
  selectedDate,
  tasks,
  projects,
  tags,
  onSelectTask,
  onToggleTask,
  onDragStart,
}: CalendarDayViewProps) {
  const dateKey = toCivilDateKey(selectedDate);

  const projectMap = useMemo(() => {
    const map = new Map<string, ProjectDto>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const tagMap = useMemo(() => {
    const map = new Map<string, TagDto>();
    for (const t of tags) map.set(t.id, t);
    return map;
  }, [tags]);

  const dayTasks = useMemo(() => {
    const byDay = groupTasksByDueDate(tasks);
    return byDay.get(dateKey) ?? [];
  }, [tasks, dateKey]);

  const { allDayTasks, timedTasks } = useMemo(() => splitDayTasks(dayTasks), [dayTasks]);

  if (dayTasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<CalendarOff size={40} />} title="No tasks for this day" />
      </div>
    );
  }

  const renderTaskCard = (task: TaskDto) => {
    const project = task.project_id ? (projectMap.get(task.project_id) ?? null) : null;
    const taskTags = task.tag_ids
      .map((id) => tagMap.get(id))
      .filter((t): t is TagDto => t !== undefined);
    const timeLabel = task.due_time?.time ? formatCivilTime(task.due_time.time) : null;

    return (
      <CalendarTaskCard
        key={task.id}
        task={task}
        project={project}
        tags={taskTags}
        onSelectTask={onSelectTask}
        onToggleTask={onToggleTask}
        onDragStart={onDragStart}
        size="day"
        timeLabel={timeLabel}
        draggable
      />
    );
  };

  return (
    <div className="flex-1 space-y-6 overflow-auto p-4">
      {allDayTasks.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-on-surface">
            All Day
          </h3>
          <div className="space-y-1.5">{allDayTasks.map(renderTaskCard)}</div>
        </section>
      )}

      {timedTasks.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-on-surface">
            Scheduled
          </h3>
          <div className="space-y-1.5">{timedTasks.map(renderTaskCard)}</div>
        </section>
      )}
    </div>
  );
}
