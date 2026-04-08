import { useState, useRef, useCallback } from "react";
import { Bell, Repeat, X } from "lucide-react";
import type { Task, UpdateTaskInput } from "../../../core/types.js";
import { DatePicker } from "../DatePicker.js";
import { RecurrencePicker, formatRecurrenceLabel } from "../RecurrencePicker.js";

interface ReminderRecurrenceSectionProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
}

export function ReminderRecurrenceSection({ task, onUpdate }: ReminderRecurrenceSectionProps) {
  const currentRemindAt = task.remindAt ?? null;
  const [showRemindAtPicker, setShowRemindAtPicker] = useState(false);
  const [showRecurrencePicker, setShowRecurrencePicker] = useState(false);
  const reminderBtnRef = useRef<HTMLButtonElement>(null);

  const handleRemindAtChange = useCallback(
    (date: string | null) => {
      onUpdate(task.id, { remindAt: date ? new Date(date).toISOString() : null });
      setShowRemindAtPicker(false);
    },
    [task.id, onUpdate],
  );

  const handleRecurrenceChange = useCallback(
    (recurrence: string | null) => {
      onUpdate(task.id, { recurrence });
      setShowRecurrencePicker(false);
    },
    [task.id, onUpdate],
  );

  return (
    <div className="space-y-4">
      {/* Reminder */}
      <div className="relative">
        <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
          <Bell size={12} /> Reminder
        </label>
        <button
          ref={reminderBtnRef}
          onClick={() => setShowRemindAtPicker((prev) => !prev)}
          className="w-full rounded-xl px-2 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-tertiary"
        >
          {currentRemindAt ? (
            new Date(currentRemindAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          ) : (
            <span className="text-on-surface-muted">No reminder</span>
          )}
        </button>
        {currentRemindAt && (
          <button
            onClick={() => handleRemindAtChange(null)}
            className="absolute top-0 right-0 text-on-surface-muted hover:text-on-surface transition-colors p-0.5"
            title="Clear reminder"
          >
            <X size={12} />
          </button>
        )}
        {showRemindAtPicker && (
          <DatePicker
            value={currentRemindAt}
            onChange={handleRemindAtChange}
            showTime={true}
            onClose={() => setShowRemindAtPicker(false)}
            triggerRef={reminderBtnRef}
          />
        )}
      </div>

      {/* Recurrence */}
      <div className="border-t border-border/60 pt-4" />
      <div className="relative">
        <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
          <Repeat size={12} /> Recurrence
        </label>
        <button
          onClick={() => setShowRecurrencePicker((prev) => !prev)}
          className="w-full rounded-xl px-2 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-tertiary"
        >
          {task.recurrence ? (
            formatRecurrenceLabel(task.recurrence)
          ) : (
            <span className="text-on-surface-muted">No repeat</span>
          )}
        </button>
        {task.recurrence && (
          <button
            onClick={() => handleRecurrenceChange(null)}
            className="absolute top-0 right-0 text-on-surface-muted hover:text-on-surface transition-colors p-0.5"
            title="Clear recurrence"
          >
            <X size={12} />
          </button>
        )}
        {showRecurrencePicker && (
          <RecurrencePicker
            value={task.recurrence ?? null}
            onChange={handleRecurrenceChange}
            onClose={() => setShowRecurrencePicker(false)}
          />
        )}
      </div>
    </div>
  );
}
