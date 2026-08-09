/**
 * Completed view: completed + cancelled history grouped by day.
 * Preserves the legacy CheckCircle2 header, project filter, and grouped rows.
 */
import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { EmptyState } from "../components/Skeleton";
import { useViewTasks } from "../hooks/useViewTasks";
import { useWorkspace } from "../context/WorkspaceContext";
import { formatTimestampTime } from "../lib/dates";
import { groupCompletedHistory, historyTimestamp } from "./completedHistory";

interface CompletedProps {
  onSelectTask: (id: string) => void;
}

function formatGroupDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "long" });
}

function formatTime(isoStr: string): string {
  return formatTimestampTime(isoStr);
}

export function Completed({ onSelectTask }: CompletedProps) {
  const { catalog } = useWorkspace();
  const { tasks, loading, error, reload } = useViewTasks({ view: "completed", limit: 100 });
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);

  const projectMap = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const p of catalog?.projects ?? []) map.set(p.id, { name: p.name, color: p.color });
    return map;
  }, [catalog]);

  const grouped = useMemo(() => {
    const filtered = tasks.filter((t) => {
      if (t.status !== "completed" && t.status !== "cancelled") return false;
      if (filterProjectId && t.project_id !== filterProjectId) return false;
      return true;
    });
    return groupCompletedHistory(filtered);
  }, [tasks, filterProjectId]);

  const completedCount = useMemo(
    () => grouped.reduce((sum, group) => sum + group.tasks.length, 0),
    [grouped],
  );

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-4 md:mb-6">
          <CheckCircle2 size={24} className="text-success" />
          <h1 className="text-xl md:text-2xl font-bold text-on-surface">Completed</h1>
        </div>
        <p className="text-sm text-on-surface-muted" role="status">
          Loading…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4">
        <p className="text-sm font-medium text-error">Could not load completed tasks: {error}</p>
        <button
          onClick={reload}
          className="mt-2 rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action"
        >
          Retry
        </button>
      </div>
    );
  }

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
          className="px-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {(catalog?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {completedCount === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={40} strokeWidth={1.25} />}
          title="No completed tasks yet"
          description="Completed tasks will appear here."
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
                  const project = task.project_id ? projectMap.get(task.project_id) : null;
                  const dateField = historyTimestamp(task);
                  return (
                    <div
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectTask(task.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectTask(task.id);
                        }
                      }}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer hover:bg-surface-secondary hover:ring-1 hover:ring-accent-action/30"
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
                      {dateField && (
                        <span className="text-xs text-on-surface-muted flex-shrink-0">
                          {formatTime(dateField)}
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
