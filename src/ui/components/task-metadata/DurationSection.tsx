import { Clock } from "lucide-react";
import type { Task, UpdateTaskInput } from "../../../core/types.js";

interface DurationSectionProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
}

export function DurationSection({ task, onUpdate }: DurationSectionProps) {
  return (
    <>
      {/* Estimated time */}
      <div>
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
          <Clock size={12} /> Estimated time
        </label>
        <input
          type="number"
          min={1}
          value={task.estimatedMinutes ?? ""}
          placeholder="Minutes"
          onChange={(e) => {
            const val = e.target.value ? parseInt(e.target.value, 10) : null;
            onUpdate(task.id, { estimatedMinutes: val });
          }}
          className="mt-1.5 w-full text-sm bg-transparent border border-border rounded-md px-3 py-1.5 text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {task.estimatedMinutes != null && task.estimatedMinutes > 0 && (
          <span className="text-xs text-on-surface-muted mt-0.5 block">
            {task.estimatedMinutes < 60
              ? `${task.estimatedMinutes}m`
              : `${Math.floor(task.estimatedMinutes / 60)}h${task.estimatedMinutes % 60 > 0 ? ` ${task.estimatedMinutes % 60}m` : ""}`}
          </span>
        )}
      </div>

      {/* Actual time -- only visible for completed tasks */}
      {task.status === "completed" && (
        <div>
          <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
            <Clock size={12} /> Actual time (minutes)
          </label>
          <input
            type="number"
            min={0}
            value={task.actualMinutes ?? ""}
            placeholder="Minutes"
            onChange={(e) => {
              const val = e.target.value ? parseInt(e.target.value, 10) : null;
              onUpdate(task.id, { actualMinutes: val });
            }}
            className="mt-1.5 w-full text-sm bg-transparent border border-border rounded-md px-3 py-1.5 text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {task.estimatedMinutes != null &&
            task.actualMinutes != null &&
            task.actualMinutes > 0 && (
              <span
                className={`text-xs mt-0.5 block ${
                  task.actualMinutes <= task.estimatedMinutes * 1.2
                    ? "text-success"
                    : "text-warning"
                }`}
              >
                {Math.round((task.actualMinutes / task.estimatedMinutes) * 100)}% of estimate
              </span>
            )}
        </div>
      )}
    </>
  );
}
