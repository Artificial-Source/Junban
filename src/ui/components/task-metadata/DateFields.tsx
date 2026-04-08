import { useState, useRef, useCallback } from "react";
import { Calendar, AlertTriangle, X } from "lucide-react";
import type { Task, UpdateTaskInput } from "../../../core/types.js";
import { DatePicker } from "../DatePicker.js";

interface DateFieldsProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  showDeadline: boolean;
}

export function DateFields({ task, onUpdate, showDeadline }: DateFieldsProps) {
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showDeadlinePicker, setShowDeadlinePicker] = useState(false);
  const dueDateBtnRef = useRef<HTMLButtonElement>(null);
  const deadlineBtnRef = useRef<HTMLButtonElement>(null);

  const handleDueDateChange = useCallback(
    (date: string | null) => {
      if (!date) {
        onUpdate(task.id, { dueDate: null, dueTime: false });
      } else {
        onUpdate(task.id, { dueDate: new Date(date).toISOString(), dueTime: false });
      }
      setShowDatePicker(false);
    },
    [task.id, onUpdate],
  );

  const handleDeadlineChange = useCallback(
    (date: string | null) => {
      onUpdate(task.id, { deadline: date ? new Date(date).toISOString() : null });
      setShowDeadlinePicker(false);
    },
    [task.id, onUpdate],
  );

  return (
    <div className="space-y-4">
      {/* Due Date */}
      <div className="relative">
        <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
          <Calendar size={12} /> Date
        </label>
        <button
          ref={dueDateBtnRef}
          onClick={() => setShowDatePicker((prev) => !prev)}
          className="w-full rounded-xl px-2 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-tertiary"
        >
          {task.dueDate ? (
            new Date(task.dueDate).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          ) : (
            <span className="text-on-surface-muted">No date</span>
          )}
        </button>
        {task.dueDate && (
          <button
            onClick={() => handleDueDateChange(null)}
            className="absolute top-0 right-0 text-on-surface-muted hover:text-on-surface transition-colors p-0.5"
            title="Clear date"
          >
            <X size={12} />
          </button>
        )}
        {showDatePicker && (
          <DatePicker
            value={task.dueDate}
            onChange={handleDueDateChange}
            onClose={() => setShowDatePicker(false)}
            triggerRef={dueDateBtnRef}
          />
        )}
      </div>

      {/* Deadline */}
      {showDeadline && (
        <div className="relative">
          <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
            <AlertTriangle size={12} /> Deadline
          </label>
          <button
            ref={deadlineBtnRef}
            onClick={() => setShowDeadlinePicker((prev) => !prev)}
            className="w-full rounded-xl px-2 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-tertiary"
          >
            {task.deadline ? (
              <span className={new Date(task.deadline) < new Date() ? "text-error" : ""}>
                {new Date(task.deadline).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            ) : (
              <span className="text-on-surface-muted">No deadline</span>
            )}
          </button>
          {task.deadline && (
            <button
              onClick={() => handleDeadlineChange(null)}
              className="absolute top-0 right-0 text-on-surface-muted hover:text-on-surface transition-colors p-0.5"
              title="Clear deadline"
            >
              <X size={12} />
            </button>
          )}
          {showDeadlinePicker && (
            <DatePicker
              value={task.deadline}
              onChange={handleDeadlineChange}
              onClose={() => setShowDeadlinePicker(false)}
              triggerRef={deadlineBtnRef}
            />
          )}
        </div>
      )}
    </div>
  );
}
