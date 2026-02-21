import { useEffect, useRef } from "react";
import { Calendar, Flag, Repeat, Tag } from "lucide-react";
import type { Task } from "../../core/types.js";

interface TaskPreviewProps {
  task: Task;
  anchorRect: DOMRect;
  onClose: () => void;
}

export function TaskPreview({ task, anchorRect, onClose }: TaskPreviewProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Position below the anchor
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(anchorRect.left, window.innerWidth - 320),
    top: anchorRect.bottom + 4,
    zIndex: 60,
  };

  return (
    <div
      ref={ref}
      className="w-72 p-3 bg-surface border border-border rounded-lg shadow-xl animate-scale-fade-in"
      style={style}
      role="tooltip"
    >
      <h3 className="text-sm font-medium text-on-surface truncate">{task.title}</h3>

      {task.description && (
        <p className="text-xs text-on-surface-muted mt-1 line-clamp-3">{task.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {task.priority && (
          <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-surface-tertiary">
            <Flag size={10} />P{task.priority}
          </span>
        )}
        {task.dueDate && (
          <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
            <Calendar size={10} />
            {new Date(task.dueDate).toLocaleDateString()}
          </span>
        )}
        {task.recurrence && (
          <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
            <Repeat size={10} />
            {task.recurrence}
          </span>
        )}
        {task.tags.length > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
            <Tag size={10} />
            {task.tags.map((t) => t.name).join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}
