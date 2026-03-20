import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { XCircle } from "lucide-react";
import type { Task, Project } from "../../core/types.js";
import { EmptyState } from "../components/EmptyState.js";

/** Virtualize only when the total item count exceeds this threshold. */
const VIRTUALIZE_THRESHOLD = 50;

/** Estimated height for a group header row. */
const GROUP_HEADER_HEIGHT = 32;

/** Estimated height for a task row. */
const TASK_ROW_HEIGHT = 44;

interface CancelledProps {
  tasks: Task[];
  projects: Project[];
  onSelectTask?: (id: string) => void;
  onRestoreTask?: (id: string) => void;
}

function formatGroupDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    weekday: "long",
  });
}

function formatTime(isoStr: string): string {
  const date = new Date(isoStr);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

type FlatRow =
  | { type: "header"; date: string }
  | { type: "task"; task: Task; project: Project | null };

export function Cancelled({ tasks, projects, onSelectTask, onRestoreTask }: CancelledProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const cancelledTasks = useMemo(() => {
    return tasks
      .filter((t) => t.status === "cancelled")
      .sort((a, b) => {
        const dateA = a.completedAt ?? a.updatedAt;
        const dateB = b.completedAt ?? b.updatedAt;
        return dateB.localeCompare(dateA);
      });
  }, [tasks]);

  const grouped = useMemo(() => {
    const groups: { date: string; tasks: Task[] }[] = [];
    let currentDate = "";
    let currentGroup: Task[] = [];

    for (const task of cancelledTasks) {
      const dateField = task.completedAt ?? task.updatedAt;
      const day = dateField.split("T")[0] ?? "unknown";
      if (day !== currentDate) {
        if (currentGroup.length > 0) {
          groups.push({ date: currentDate, tasks: currentGroup });
        }
        currentDate = day;
        currentGroup = [task];
      } else {
        currentGroup.push(task);
      }
    }
    if (currentGroup.length > 0) {
      groups.push({ date: currentDate, tasks: currentGroup });
    }

    return groups;
  }, [cancelledTasks]);

  /** Flatten groups into a single list of rows for virtualization. */
  const flatRows = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const group of grouped) {
      rows.push({ type: "header", date: group.date });
      for (const task of group.tasks) {
        const project = task.projectId ? projectMap.get(task.projectId) ?? null : null;
        rows.push({ type: "task", task, project });
      }
    }
    return rows;
  }, [grouped, projectMap]);

  const shouldVirtualize = cancelledTasks.length > VIRTUALIZE_THRESHOLD;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <XCircle size={24} className="text-danger" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Cancelled</h1>
      </div>

      {cancelledTasks.length === 0 ? (
        <EmptyState
          icon={<XCircle size={40} strokeWidth={1.25} />}
          title="No cancelled tasks"
          description="Cancelled tasks will appear here."
        />
      ) : shouldVirtualize ? (
        <VirtualizedCancelledRows
          flatRows={flatRows}
          onSelectTask={onSelectTask}
          onRestoreTask={onRestoreTask}
          scrollContainerRef={scrollContainerRef}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.date}>
              <h2 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2 px-1">
                {group.date === "unknown" ? "Unknown date" : formatGroupDate(group.date)}
              </h2>
              <div className="space-y-0.5">
                {group.tasks.map((task) => {
                  const project = task.projectId ? projectMap.get(task.projectId) : null;
                  return (
                    <CancelledTaskRow
                      key={task.id}
                      task={task}
                      project={project ?? null}
                      onSelectTask={onSelectTask}
                      onRestoreTask={onRestoreTask}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CancelledTaskRow({
  task,
  project,
  onSelectTask,
  onRestoreTask,
}: {
  task: Task;
  project: Project | null;
  onSelectTask?: (id: string) => void;
  onRestoreTask?: (id: string) => void;
}) {
  const dateField = task.completedAt ?? task.updatedAt;
  return (
    <div
      role={onSelectTask ? "button" : undefined}
      tabIndex={onSelectTask ? 0 : undefined}
      onClick={onSelectTask ? () => onSelectTask(task.id) : undefined}
      onKeyDown={
        onSelectTask
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectTask(task.id);
              }
            }
          : undefined
      }
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
        onSelectTask
          ? "cursor-pointer hover:bg-surface-secondary hover:ring-1 hover:ring-accent/30"
          : "hover:bg-surface-secondary"
      }`}
    >
      <XCircle size={18} className="text-danger flex-shrink-0" />
      <span className="flex-1 text-sm text-on-surface-muted line-through">{task.title}</span>
      {project && (
        <span className="flex items-center gap-1.5 text-xs text-on-surface-muted flex-shrink-0">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: project.color }}
          />
          {project.name}
        </span>
      )}
      {dateField && (
        <span className="text-xs text-on-surface-muted flex-shrink-0">
          {formatTime(dateField)}
        </span>
      )}
      {onRestoreTask && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRestoreTask(task.id);
          }}
          className="px-2.5 py-1 text-xs font-medium text-accent bg-accent/10 rounded-md hover:bg-accent/20 transition-colors flex-shrink-0"
        >
          Restore
        </button>
      )}
    </div>
  );
}

function VirtualizedCancelledRows({
  flatRows,
  onSelectTask,
  onRestoreTask,
  scrollContainerRef,
}: {
  flatRows: FlatRow[];
  onSelectTask?: (id: string) => void;
  onRestoreTask?: (id: string) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) =>
      flatRows[index]?.type === "header" ? GROUP_HEADER_HEIGHT : TASK_ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div
      ref={scrollContainerRef}
      className="overflow-auto"
      style={{ maxHeight: "calc(100vh - 200px)" }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = flatRows[virtualRow.index];
          if (!row) return null;

          if (row.type === "header") {
            return (
              <div
                key={`header-${row.date}`}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <h2 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2 px-1 pt-4 first:pt-0">
                  {row.date === "unknown" ? "Unknown date" : formatGroupDate(row.date)}
                </h2>
              </div>
            );
          }

          return (
            <div
              key={row.task.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <CancelledTaskRow
                task={row.task}
                project={row.project}
                onSelectTask={onSelectTask}
                onRestoreTask={onRestoreTask}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
