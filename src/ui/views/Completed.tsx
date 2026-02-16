import { useState, useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import type { Task, Project } from "../../core/types.js";

interface CompletedProps {
  tasks: Task[];
  projects: Project[];
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

export function Completed({ tasks, projects }: CompletedProps) {
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);

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

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <CheckCircle2 size={24} className="text-success" />
        <h1 className="text-2xl font-bold text-on-surface">Completed</h1>
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
        <div className="flex flex-col items-center justify-center py-12 text-on-surface-muted">
          <CheckCircle2 size={40} strokeWidth={1.25} className="mb-3 opacity-50" />
          <p className="text-sm">No completed tasks yet.</p>
        </div>
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
                    <div
                      key={task.id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-secondary transition-colors"
                    >
                      <CheckCircle2 size={18} className="text-success flex-shrink-0" />
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
                      {task.completedAt && (
                        <span className="text-xs text-on-surface-muted flex-shrink-0">
                          {formatTime(task.completedAt)}
                        </span>
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
