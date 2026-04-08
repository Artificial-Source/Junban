import { useState, useEffect } from "react";
import { Pencil } from "lucide-react";
import { MarkdownMessage } from "../chat/MarkdownMessage.js";

interface TaskDetailDescriptionProps {
  description: string | null;
  onDescriptionChange: (description: string | null) => void;
  taskId: string;
}

export function TaskDetailDescription({
  description,
  onDescriptionChange,
  taskId,
}: TaskDetailDescriptionProps) {
  const [localDescription, setLocalDescription] = useState(description ?? "");
  const [editing, setEditing] = useState(false);

  // Reset when task changes
  useEffect(() => {
    setLocalDescription(description ?? "");
    setEditing(false);
  }, [taskId, description]);

  const handleBlur = () => {
    const newDesc = localDescription || null;
    if (newDesc !== description) {
      onDescriptionChange(newDesc);
    }
    setEditing(false);
  };

  const startEditing = () => setEditing(true);
  const shellClass = "min-h-[88px] rounded-xl border border-transparent px-0 py-2";

  return (
    <div className="relative group/desc">
      {editing ? (
        <div className={shellClass}>
          <textarea
            aria-label="Description"
            value={localDescription}
            onChange={(e) => setLocalDescription(e.target.value)}
            onBlur={handleBlur}
            autoFocus
            placeholder="Add a description..."
            className="block min-h-[56px] w-full resize-none border-none bg-transparent p-0 text-sm leading-6 text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-0"
          />
        </div>
      ) : localDescription ? (
        <div
          className={`${shellClass} prose-sm min-h-[88px] cursor-text text-sm text-on-surface`}
          onClick={startEditing}
        >
          <MarkdownMessage content={localDescription} />
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Description"
          onClick={startEditing}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              startEditing();
            }
          }}
          className={`${shellClass} w-full cursor-text text-left text-sm leading-6 text-on-surface-muted/50 outline-none`}
        >
          <span>Add a description...</span>
        </div>
      )}
      {!editing && localDescription && (
        <button
          onClick={startEditing}
          className="absolute top-0 right-0 p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary opacity-0 group-hover/desc:opacity-100 transition-opacity"
          title="Edit description"
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}
