import { useCallback } from "react";
import type { Task, UpdateTaskInput } from "../../../core/types.js";
import { DreadLevelSelector } from "../DreadLevelSelector.js";
import { PRIORITIES } from "./metadata-constants.js";

interface PriorityDreadSectionProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
}

export function PriorityDreadSection({ task, onUpdate }: PriorityDreadSectionProps) {
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
    <>
      {/* Priority */}
      <div>
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
          Priority
        </label>
        <div className="flex gap-1.5 mt-1.5">
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              onClick={() => handlePriorityClick(p.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
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
      <div>
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
          Dread Level
        </label>
        <div className="mt-1.5">
          <DreadLevelSelector value={task.dreadLevel} onChange={handleDreadLevelChange} />
        </div>
      </div>
    </>
  );
}
