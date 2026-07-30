/**
 * Someday view: pending someday tasks with Activate action.
 * Preserves the legacy Lightbulb header and row layout.
 */
import { useMemo } from "react";
import { Lightbulb } from "lucide-react";
import { EmptyState } from "../components/Skeleton";
import { useViewTasks } from "../hooks/useViewTasks";
import { useTaskMutations } from "../hooks/useTaskMutations";

interface SomedayProps {
  onSelectTask: (id: string) => void;
}

export function Someday({ onSelectTask }: SomedayProps) {
  const { tasks, loading, error, reload } = useViewTasks({ view: "someday", limit: 100 });
  const { patchTask } = useTaskMutations();

  const somedayTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.someday && t.status === "pending")
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [tasks],
  );

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-4 md:mb-6">
          <Lightbulb size={24} className="text-warning" />
          <h1 className="text-xl md:text-2xl font-bold text-on-surface">Someday / Maybe</h1>
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
        <p className="text-sm font-medium text-error">Could not load someday tasks: {error}</p>
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
        <Lightbulb size={24} className="text-warning" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Someday / Maybe</h1>
      </div>

      {somedayTasks.length === 0 ? (
        <EmptyState
          icon={<Lightbulb size={40} strokeWidth={1.25} />}
          title="No someday tasks"
          description="Mark tasks as someday to park them here."
        />
      ) : (
        <div className="space-y-0.5">
          {somedayTasks.map((task) => (
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
              <Lightbulb size={18} className="text-on-surface-muted flex-shrink-0" />
              <span className="flex-1 text-sm text-on-surface">{task.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void patchTask(task.id, { someday: false });
                }}
                className="px-2.5 py-1 text-xs font-medium text-accent-foreground bg-accent-action/10 rounded-md hover:bg-accent-action/20 transition-colors flex-shrink-0"
              >
                Activate
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
