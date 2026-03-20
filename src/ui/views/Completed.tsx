import { useState, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckCircle2 } from "lucide-react";
import type { Task, Project } from "../../core/types.js";
import { EmptyState } from "../components/EmptyState.js";

/** Virtualize only when the total item count exceeds this threshold. */
const VIRTUALIZE_THRESHOLD = 50;

/** Estimated height for a group header row. */
const GROUP_HEADER_HEIGHT = 32;

/** Estimated height for a task row. */
const TASK_ROW_HEIGHT = 44;

interface CompletedProps {
  tasks: Task[];
  projects: Project[];
  onSelectTask?: (id: string) => void;
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

export function Completed({ tasks, projects, onSelectTask }: CompletedProps) {
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const completedTasks = useMemo(() => {
    return tasks
      .filter((t) => {
        if (t.status !== "completed" && t.status !== "cancelled") return false;
        if (filterProjectId && t.projectId !== filterProjectId) return false;
        return true;
      })
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  }, [tasks, filterProjectId]);

  const grouped = useMemo(() => {
    const groups: { date: string; tasks: Task[] }[] = [];
    let currentDate = "";
    let currentGroup: Task[] = [];

    for (const task of completedTasks) {
      const day = task.completedAt?.split("T")[0] ?? "unknown";
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
  }, [completedTasks]);

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

  const shouldVirtualize = completedTasks.length > VIRTUALIZE_THRESHOLD;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <CheckCircle2 size={24} className="text-success" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Completed</h1>
      </div>

      <div className="mb-4">
        <select
          value={filterProjectId ?? ""}
          onChange={(e) => setFilterProjectId(e.target.value || null)}
          className="px-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {completedTasks.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={40} strokeWidth={1.25} />}
          title="No completed tasks yet"
          description="Completed tasks will appear here."
        />
      ) : shouldVirtualize ? (
        <VirtualizedCompletedRows
          flatRows={flatRows}
          onSelectTask={onSelectTask}
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
                    <CompletedTaskRow
                      key={task.id}
                      task={task}
                      project={project ?? null}
                      onSelectTask={onSelectTask}
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

function CompletedTaskRow({
  task,
  project,
  onSelectTask,
}: {
  task: Task;
  project: Project | null;
  onSelectTask?: (id: string) => void;
}) {
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
      <CheckCircle2 size={18} className="text-success flex-shrink-0" />
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
      {task.completedAt && (
        <span className="text-xs text-on-surface-muted flex-shrink-0">
          {formatTime(task.completedAt)}
        </span>
      )}
    </div>
  );
}

function VirtualizedCompletedRows({
  flatRows,
  onSelectTask,
  scrollContainerRef,
}: {
  flatRows: FlatRow[];
  onSelectTask?: (id: string) => void;
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
              <CompletedTaskRow
                task={row.task}
                project={row.project}
                onSelectTask={onSelectTask}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
