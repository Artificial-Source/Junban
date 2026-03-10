import type { Task, UpdateTaskInput } from "../../../core/types.js";
import { STATUS_OPTIONS } from "./metadata-constants.js";

interface StatusSectionProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
}

export function StatusSection({ task, onUpdate }: StatusSectionProps) {
  const handleStatusChange = (newStatus: "pending" | "completed" | "cancelled") => {
    if (newStatus === task.status) return;
    const updates: Record<string, unknown> = { status: newStatus };
    if (newStatus === "pending") {
      updates.completedAt = null;
    } else if (newStatus === "completed" && !task.completedAt) {
      updates.completedAt = new Date().toISOString();
    }
    onUpdate(task.id, updates as UpdateTaskInput);
  };

  return (
    <div>
      <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
        Status
      </label>
      <div className="flex gap-1.5 mt-1.5 flex-wrap">
        {STATUS_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isActive = task.status === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleStatusChange(opt.value)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                isActive
                  ? `bg-surface-tertiary ${opt.color} ring-1 ring-current/20`
                  : "bg-surface-tertiary text-on-surface-muted hover:text-on-surface-secondary"
              }`}
            >
              <Icon size={12} />
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
