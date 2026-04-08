import { useCallback } from "react";
import type { Task, UpdateTaskInput } from "../../../core/types.js";
import { DreadLevelSelector } from "../DreadLevelSelector.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";
import { PRIORITIES } from "./metadata-constants.js";

interface PriorityDreadSectionProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
}

export function PriorityDreadSection({ task, onUpdate }: PriorityDreadSectionProps) {
  const { settings } = useGeneralSettings();
  const showDreadLevel = settings.eat_the_frog_enabled !== "false";

  const handlePriorityClick = (priority: number) => {
    const newPriority = task.priority === priority ? null : priority;
    onUpdate(task.id, { priority: newPriority });
  };

  const handleDreadLevelChange = useCallback(
    (level: number | null) => {
      onUpdate(task.id, { dreadLevel: level });
    },
    [task.id, onUpdate],
  );

  return (
    <div className="space-y-4">
      {/* Priority */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-on-surface-muted">
          Priority
        </label>
        <div className="flex gap-2">
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              onClick={() => handlePriorityClick(p.value)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                task.priority === p.value
                  ? p.activeClass
                  : "bg-surface-tertiary text-on-surface-muted hover:text-on-surface-secondary"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Dread Level */}
      {showDreadLevel && (
        <div>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-on-surface-muted">
            Dread Level
          </label>
          <div>
            <DreadLevelSelector value={task.dreadLevel} onChange={handleDreadLevelChange} />
          </div>
        </div>
      )}
    </div>
  );
}
