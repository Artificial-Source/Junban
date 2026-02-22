import { useMemo } from "react";
import { Lightbulb } from "lucide-react";
import type { Task } from "../../core/types.js";
import { EmptyState } from "../components/EmptyState.js";

interface SomedayProps {
  tasks: Task[];
  onSelectTask?: (id: string) => void;
  onActivateTask?: (id: string) => void;
}

export function Someday({ tasks, onSelectTask, onActivateTask }: SomedayProps) {
  const somedayTasks = useMemo(() => {
    return tasks
      .filter((t) => t.isSomeday === true && t.status === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [tasks]);

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
              <Lightbulb size={18} className="text-on-surface-muted flex-shrink-0" />
              <span className="flex-1 text-sm text-on-surface">{task.title}</span>
              {onActivateTask && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onActivateTask(task.id);
                  }}
                  className="px-2.5 py-1 text-xs font-medium text-accent bg-accent/10 rounded-md hover:bg-accent/20 transition-colors flex-shrink-0"
                >
                  Activate
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
