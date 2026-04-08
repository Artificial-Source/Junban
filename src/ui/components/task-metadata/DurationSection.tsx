import { Clock } from "lucide-react";
import type { Task, UpdateTaskInput } from "../../../core/types.js";

interface DurationSectionProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
}

export function DurationSection({ task, onUpdate }: DurationSectionProps) {
  return (
    <div className="space-y-4">
      {/* Estimated time */}
      <div>
        <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
          <Clock size={12} /> Estimated time
        </label>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={task.estimatedMinutes ?? ""}
          placeholder="Minutes"
          onChange={(e) => {
            const val = e.target.value ? parseInt(e.target.value, 10) : null;
            onUpdate(task.id, { estimatedMinutes: val });
          }}
          className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2.5 text-sm text-on-surface placeholder-on-surface-muted/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {task.estimatedMinutes != null && task.estimatedMinutes > 0 && (
          <span className="mt-2 block text-xs text-on-surface-muted">
            {task.estimatedMinutes < 60
              ? `${task.estimatedMinutes}m`
              : `${Math.floor(task.estimatedMinutes / 60)}h${task.estimatedMinutes % 60 > 0 ? ` ${task.estimatedMinutes % 60}m` : ""}`}
          </span>
        )}
      </div>

      {/* Actual time -- only visible for completed tasks */}
      {task.status === "completed" && (
        <div>
          <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
            <Clock size={12} /> Actual time (minutes)
          </label>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={task.actualMinutes ?? ""}
            placeholder="Minutes"
            onChange={(e) => {
              const val = e.target.value ? parseInt(e.target.value, 10) : null;
              onUpdate(task.id, { actualMinutes: val });
            }}
            className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2.5 text-sm text-on-surface placeholder-on-surface-muted/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {task.estimatedMinutes != null &&
            task.actualMinutes != null &&
            task.actualMinutes > 0 && (
              <span
                className={`mt-2 block text-xs ${
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
    </div>
  );
}
