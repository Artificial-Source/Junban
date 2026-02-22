import { useMemo } from "react";
import { XCircle } from "lucide-react";
import type { Task, Project } from "../../core/types.js";
import { EmptyState } from "../components/EmptyState.js";

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

export function Cancelled({ tasks, projects, onSelectTask, onRestoreTask }: CancelledProps) {
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
                  const dateField = task.completedAt ?? task.updatedAt;
                  return (
                    <div
                      key={task.id}
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
                      <span className="flex-1 text-sm text-on-surface-muted line-through">
                        {task.title}
                      </span>
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
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
