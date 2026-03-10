import { CompletionRing } from "../../components/CompletionRing.js";
import type { Project as ProjectType } from "../../../core/types.js";

interface ProjectHeaderProps {
  project: ProjectType;
  taskCount: number;
  completedCount: number;
  totalForProgress: number;
}

export function ProjectHeader({
  project,
  taskCount,
  completedCount,
  totalForProgress,
}: ProjectHeaderProps) {
  return (
    <div className="flex items-center gap-3 mb-4 md:mb-6">
      {project.icon ? (
        <span className="text-2xl leading-none flex-shrink-0">{project.icon}</span>
      ) : (
        <div
          className="w-4 h-4 rounded-full flex-shrink-0"
          style={{ backgroundColor: project.color }}
        />
      )}
      <h1 className="text-xl md:text-2xl font-bold text-on-surface">{project.name}</h1>
      <span className="text-sm text-on-surface-muted">
        {taskCount} {taskCount === 1 ? "task" : "tasks"}
      </span>
      {totalForProgress > 0 && (
        <CompletionRing completed={completedCount} total={totalForProgress} />
      )}
    </div>
  );
}
