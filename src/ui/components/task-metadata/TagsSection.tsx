import { useCallback } from "react";
import { Tag } from "lucide-react";
import type { Task, UpdateTaskInput } from "../../../core/types.js";
import { TagsInput } from "../TagsInput.js";

interface TagsSectionProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  availableTags: string[];
}

export function TagsSection({ task, onUpdate, availableTags }: TagsSectionProps) {
  // Build tag name -> color lookup for colored chips
  const tagColors: Record<string, string> = {};
  for (const tag of task.tags) {
    if (tag.color) tagColors[tag.name] = tag.color;
  }

  const handleTagsChange = useCallback(
    (tags: string[]) => {
      onUpdate(task.id, { tags });
    },
    [task.id, onUpdate],
  );

  return (
    <div>
      <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
        <Tag size={12} /> Labels
      </label>
      <div>
        <TagsInput
          value={task.tags.map((t) => t.name)}
          onChange={handleTagsChange}
          suggestions={availableTags}
          tagColors={tagColors}
        />
      </div>
    </div>
  );
}
