/**
 * Cancelled view: cancelled-only history with Restore action.
 * Preserves the legacy XCircle header and grouped rows.
 */
import { useMemo } from "react";
import { XCircle } from "lucide-react";
import { EmptyState } from "../components/Skeleton";
import { useViewTasks } from "../hooks/useViewTasks";
import { useWorkspace } from "../context/WorkspaceContext";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { calendarDayKey } from "../lib/dates";

interface CancelledProps {
  onSelectTask: (id: string) => void;
}

function formatGroupDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "long" });
}

function formatTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function Cancelled({ onSelectTask }: CancelledProps) {
  const { catalog } = useWorkspace();
  const { tasks, loading, error, reload } = useViewTasks({ view: "cancelled", limit: 100 });
  const { reopenTask } = useTaskMutations();

  const projectMap = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const p of catalog?.projects ?? []) map.set(p.id, { name: p.name, color: p.color });
    return map;
  }, [catalog]);

  const cancelledTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status === "cancelled")
        .sort((a, b) => {
          const dateA = a.completed_at ?? a.updated_at;
          const dateB = b.completed_at ?? b.updated_at;
          return dateB.localeCompare(dateA);
        }),
    [tasks],
  );

  const grouped = useMemo(() => {
    const groups: { date: string; tasks: typeof cancelledTasks }[] = [];
    let currentDate = "";
    let currentGroup: typeof cancelledTasks = [];
    for (const task of cancelledTasks) {
      const dateField = task.completed_at ?? task.updated_at;
      const day = calendarDayKey(dateField) ?? "unknown";
      if (day !== currentDate) {
        if (currentGroup.length > 0) groups.push({ date: currentDate, tasks: currentGroup });
        currentDate = day;
        currentGroup = [task];
      } else {
        currentGroup.push(task);
      }
    }
    if (currentGroup.length > 0) groups.push({ date: currentDate, tasks: currentGroup });
    return groups;
  }, [cancelledTasks]);

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-4 md:mb-6">
          <XCircle size={24} className="text-error" />
          <h1 className="text-xl md:text-2xl font-bold text-on-surface">Cancelled</h1>
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
        <p className="text-sm font-medium text-error">Could not load cancelled tasks: {error}</p>
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
        <XCircle size={24} className="text-error" />
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
                  const project = task.project_id ? projectMap.get(task.project_id) : null;
                  const dateField = task.completed_at ?? task.updated_at;
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
                      <XCircle size={18} className="text-error flex-shrink-0" />
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
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void reopenTask(task.id);
                        }}
                        className="px-2.5 py-1 text-xs font-medium text-accent-foreground bg-accent-action/10 rounded-md hover:bg-accent-action/20 transition-colors flex-shrink-0"
                      >
                        Restore
                      </button>
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
