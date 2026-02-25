import { useState, useCallback, useRef } from "react";
import {
  Calendar,
  AlertTriangle,
  Tag,
  Bell,
  Repeat,
  Trash2,
  X,
  Circle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import type { Task, UpdateTaskInput } from "../../core/types.js";
import { DatePicker } from "./DatePicker.js";
import { TagsInput } from "./TagsInput.js";
import { RecurrencePicker, formatRecurrenceLabel } from "./RecurrencePicker.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

const PRIORITIES = [
  { value: 1, label: "P1", activeClass: "bg-priority-1/15 text-priority-1" },
  { value: 2, label: "P2", activeClass: "bg-priority-2/15 text-priority-2" },
  { value: 3, label: "P3", activeClass: "bg-priority-3/15 text-priority-3" },
  { value: 4, label: "P4", activeClass: "bg-priority-4/15 text-priority-4" },
];

interface TaskMetadataSidebarProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  onDelete: (id: string) => void;
  availableTags?: string[];
}

export function TaskMetadataSidebar({
  task,
  onUpdate,
  onDelete,
  availableTags = [],
}: TaskMetadataSidebarProps) {
  const { settings } = useGeneralSettings();
  const currentRemindAt = task.remindAt ?? null;
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showDeadlinePicker, setShowDeadlinePicker] = useState(false);
  const [showRemindAtPicker, setShowRemindAtPicker] = useState(false);
  const [showRecurrencePicker, setShowRecurrencePicker] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const dueDateBtnRef = useRef<HTMLButtonElement>(null);
  const deadlineBtnRef = useRef<HTMLButtonElement>(null);
  const reminderBtnRef = useRef<HTMLButtonElement>(null);

  // Build tag name → color lookup for colored chips
  const tagColors: Record<string, string> = {};
  for (const tag of task.tags) {
    if (tag.color) tagColors[tag.name] = tag.color;
  }

  // Reset local state when task changes
  // (parent resets via key prop or we track task.id)
  const [trackedTaskId, setTrackedTaskId] = useState(task.id);
  if (task.id !== trackedTaskId) {
    setTrackedTaskId(task.id);
    setShowDatePicker(false);
    setShowDeadlinePicker(false);
    setShowRemindAtPicker(false);
    setShowRecurrencePicker(false);
  }

  const handlePriorityClick = (priority: number) => {
    const newPriority = task.priority === priority ? null : priority;
    onUpdate(task.id, { priority: newPriority });
  };

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

  const handleTagsChange = useCallback(
    (tags: string[]) => {
      onUpdate(task.id, { tags });
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

  const handleRemindAtChange = useCallback(
    (date: string | null) => {
      onUpdate(task.id, { remindAt: date ? new Date(date).toISOString() : null });
      setShowRemindAtPicker(false);
    },
    [task.id, onUpdate],
  );

  const handleStatusChange = (newStatus: "pending" | "completed" | "cancelled") => {
    if (newStatus === task.status) return;
    const updates: Record<string, unknown> = { status: newStatus };
    if (newStatus === "pending") {
      updates.completedAt = null;
    } else if (newStatus === "completed" && !task.completedAt) {
      updates.completedAt = new Date().toISOString();
    }
    onUpdate(task.id, updates as UpdateTaskInput);
  };

  const STATUS_OPTIONS = [
    { value: "pending" as const, label: "Pending", icon: Circle, color: "text-on-surface-muted" },
    { value: "completed" as const, label: "Completed", icon: CheckCircle2, color: "text-success" },
    { value: "cancelled" as const, label: "Cancelled", icon: XCircle, color: "text-error" },
  ];

  return (
    <div className="w-full border-t md:w-64 md:border-t-0 md:border-l border-border overflow-auto p-4 md:p-5 space-y-5 flex-shrink-0">
      {/* Status */}
      <div>
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider">
          Status
        </label>
        <div className="flex gap-1.5 mt-1.5 flex-wrap">
          {STATUS_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const isActive = task.status === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => handleStatusChange(opt.value)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  isActive
                    ? `bg-surface-tertiary ${opt.color} ring-1 ring-current/20`
                    : "bg-surface-tertiary text-on-surface-muted hover:text-on-surface-secondary"
                }`}
              >
                <Icon size={12} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border" />

      {/* Due Date */}
      <div className="relative">
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
          <Calendar size={12} /> Date
        </label>
        <button
          ref={dueDateBtnRef}
          onClick={() => setShowDatePicker((prev) => !prev)}
          className="mt-1.5 w-full px-2 py-1.5 text-sm text-left rounded-md text-on-surface hover:bg-surface-tertiary transition-colors"
        >
          {task.dueDate ? (
            new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })
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
      {settings.feature_deadlines !== "false" && (
        <div className="relative">
          <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
            <AlertTriangle size={12} /> Deadline
          </label>
          <button
            ref={deadlineBtnRef}
            onClick={() => setShowDeadlinePicker((prev) => !prev)}
            className="mt-1.5 w-full px-2 py-1.5 text-sm text-left rounded-md text-on-surface hover:bg-surface-tertiary transition-colors"
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

      <div className="border-t border-border" />

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

      <div className="border-t border-border" />

      {/* Tags */}
      <div>
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
          <Tag size={12} /> Labels
        </label>
        <div className="mt-1.5">
          <TagsInput
            value={task.tags.map((t) => t.name)}
            onChange={handleTagsChange}
            suggestions={availableTags}
            tagColors={tagColors}
          />
        </div>
      </div>

      <div className="border-t border-border" />

      {/* Reminder */}
      <div className="relative">
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
          <Bell size={12} /> Reminder
        </label>
        <button
          ref={reminderBtnRef}
          onClick={() => setShowRemindAtPicker((prev) => !prev)}
          className="mt-1.5 w-full px-2 py-1.5 text-sm text-left rounded-md text-on-surface hover:bg-surface-tertiary transition-colors"
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
      <div className="border-t border-border" />
      <div className="relative">
        <label className="text-xs font-medium text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5">
          <Repeat size={12} /> Recurrence
        </label>
        <button
          onClick={() => setShowRecurrencePicker((prev) => !prev)}
          className="mt-1.5 w-full px-2 py-1.5 text-sm text-left rounded-md text-on-surface hover:bg-surface-tertiary transition-colors"
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

      <div className="border-t border-border" />

      {/* Delete */}
      <button
        onClick={() => {
          if (settings.confirm_delete === "true") {
            setConfirmDeleteOpen(true);
            return;
          }
          onDelete(task.id);
        }}
        className="text-sm text-error hover:text-error/80 flex items-center gap-1.5 transition-colors w-full"
      >
        <Trash2 size={14} />
        Delete task
      </button>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete task"
        message="This task will be permanently deleted. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          onDelete(task.id);
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
