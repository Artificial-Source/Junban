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

  return (
    <div className="relative group/desc">
      {editing ? (
        <textarea
          value={localDescription}
          onChange={(e) => setLocalDescription(e.target.value)}
          onBlur={handleBlur}
          autoFocus
          placeholder="Description (supports **markdown**)"
          className="w-full p-0 text-sm bg-transparent border-none text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-0 min-h-[80px] resize-none"
        />
      ) : localDescription ? (
        <div
          className="text-sm text-on-surface cursor-text min-h-[80px] prose-sm"
          onClick={() => setEditing(true)}
        >
          <MarkdownMessage content={localDescription} />
        </div>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full text-left text-sm text-on-surface-muted/50 min-h-[80px]"
        >
          Description
        </button>
      )}
      {!editing && localDescription && (
        <button
          onClick={() => setEditing(true)}
          className="absolute top-0 right-0 p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary opacity-0 group-hover/desc:opacity-100 transition-opacity"
          title="Edit description"
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}
