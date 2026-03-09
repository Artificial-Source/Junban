import type { Task } from "../../../../core/types.js";
import type { TimeBlock } from "../types.js";

interface TaskDragPreviewProps {
  task: Task;
}

interface BlockDragPreviewProps {
  block: TimeBlock;
  hasConflict?: boolean;
}

export function TaskDragPreview({ task }: TaskDragPreviewProps) {
  return (
    <div className="p-2 rounded-md border border-accent/30 bg-surface shadow-lg opacity-90 rotate-1 min-w-[200px]">
      <span className="text-sm text-on-surface">{task.title}</span>
      {task.estimatedMinutes && (
        <span className="text-xs text-on-surface-muted ml-2">
          {task.estimatedMinutes}m
        </span>
      )}
    </div>
  );
}

export function BlockDragPreview({ block, hasConflict = false }: BlockDragPreviewProps) {
  return (
    <div
      className={`p-2 rounded-md border shadow-lg opacity-90 min-w-[200px] ${
        hasConflict
          ? "border-error/50 bg-error/10"
          : "border-accent/30 bg-surface"
      }`}
    >
      <span className="text-sm text-on-surface font-medium">{block.title}</span>
      <div className="text-xs text-on-surface-secondary mt-0.5">
        {block.startTime} – {block.endTime}
      </div>
    </div>
  );
}
