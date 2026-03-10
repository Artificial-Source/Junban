import { useState } from "react";
import { Calendar, Pencil } from "lucide-react";
import type { Task } from "../../../core/types.js";
import { DatePicker } from "../DatePicker.js";

interface TaskItemActionsProps {
  task: Task;
  onSelect: (id: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
}

export function TaskItemActions({ task, onSelect, onUpdateDueDate }: TaskItemActionsProps) {
  const [showDatePicker, setShowDatePicker] = useState(false);

  return (
    <div className="relative flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150 flex-shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSelect(task.id);
        }}
        aria-label="Edit task"
        className="p-2 md:p-1 rounded hover:bg-surface-tertiary text-on-surface-muted hover:text-on-surface transition-colors"
      >
        <Pencil size={14} />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowDatePicker((prev) => !prev);
        }}
        aria-label="Set due date"
        className="p-2 md:p-1 rounded hover:bg-surface-tertiary text-on-surface-muted hover:text-on-surface transition-colors"
      >
        <Calendar size={14} />
      </button>
      {showDatePicker && (
        <DatePicker
          value={task.dueDate}
          onChange={(date) => {
            if (onUpdateDueDate) {
              onUpdateDueDate(task.id, date);
            }
            setShowDatePicker(false);
          }}
          onClose={() => setShowDatePicker(false)}
        />
      )}
    </div>
  );
}
