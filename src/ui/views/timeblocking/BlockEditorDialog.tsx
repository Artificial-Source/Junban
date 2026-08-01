/**
 * Create/edit dialog for time blocks and slots.
 * Virtual occurrences clearly label series editing and mutate the owner id.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProjectDto, TaskDto, TimeBlockDto, TimeSlotDto } from "../../api/client";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { formatRecurrenceLabel, RECURRENCE_PRESETS } from "../../lib/recurrence";
import {
  DEFAULT_BLOCK_DURATION_MINUTES,
  isVirtualOccurrence,
  minutesToCivilTime,
  normalizeCivilTime,
  seriesOwnerId,
  civilTimeToMinutes,
} from "./timeblockingRange";

export type EditorKind = "block" | "slot";

export interface BlockEditorValues {
  kind: EditorKind;
  title: string;
  date: string;
  start: string;
  end: string;
  color: string;
  locked: boolean;
  taskId: string | null;
  projectId: string | null;
  slotId: string | null;
  recurrenceRule: string | null;
  ownerId?: string;
  occurrenceKey?: string;
  seriesEdit: boolean;
}

interface BlockEditorDialogProps {
  open: boolean;
  initial: BlockEditorValues | null;
  tasks: TaskDto[];
  projects: ProjectDto[];
  slots: TimeSlotDto[];
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (values: BlockEditorValues) => Promise<boolean>;
  onDelete?: (values: BlockEditorValues) => Promise<boolean>;
}

const COLOR_OPTIONS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#ef4444",
];

export function blockToEditorValues(block: TimeBlockDto): BlockEditorValues {
  return {
    kind: "block",
    title: block.title,
    date: block.date,
    start: normalizeCivilTime(block.start),
    end: normalizeCivilTime(block.end),
    color: block.color ?? COLOR_OPTIONS[0]!,
    locked: block.locked,
    taskId: block.task_id ?? null,
    projectId: null,
    slotId: block.slot_id ?? null,
    recurrenceRule: block.recurrence_rule ?? null,
    ownerId: seriesOwnerId(block),
    occurrenceKey: block.occurrence_key,
    seriesEdit: isVirtualOccurrence(block) || Boolean(block.recurrence_rule),
  };
}

export function slotToEditorValues(slot: TimeSlotDto): BlockEditorValues {
  return {
    kind: "slot",
    title: slot.title,
    date: slot.date,
    start: normalizeCivilTime(slot.start),
    end: normalizeCivilTime(slot.end),
    color: slot.color ?? COLOR_OPTIONS[0]!,
    locked: false,
    taskId: null,
    projectId: slot.project_id ?? null,
    slotId: null,
    recurrenceRule: slot.recurrence_rule ?? null,
    ownerId: seriesOwnerId(slot),
    occurrenceKey: slot.occurrence_key,
    seriesEdit: isVirtualOccurrence(slot) || Boolean(slot.recurrence_rule),
  };
}

export function createDraftValues(input: {
  kind: EditorKind;
  date: string;
  start: string;
  end?: string;
  taskId?: string | null;
  title?: string;
}): BlockEditorValues {
  const startMin = civilTimeToMinutes(input.start) ?? 9 * 60;
  const end = input.end ?? minutesToCivilTime(startMin + DEFAULT_BLOCK_DURATION_MINUTES);
  return {
    kind: input.kind,
    title: input.title ?? (input.kind === "slot" ? "Time slot" : "New block"),
    date: input.date,
    start: normalizeCivilTime(input.start),
    end: normalizeCivilTime(end),
    color: COLOR_OPTIONS[0]!,
    locked: false,
    taskId: input.taskId ?? null,
    projectId: null,
    slotId: null,
    recurrenceRule: null,
    seriesEdit: false,
  };
}

export function BlockEditorDialog({
  open,
  initial,
  tasks,
  projects,
  slots,
  pending = false,
  error = null,
  onClose,
  onSave,
  onDelete,
}: BlockEditorDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);
  const titleId = useId();
  const [values, setValues] = useState<BlockEditorValues | null>(initial);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setLocalError(null);
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, pending, onClose]);

  const pendingTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending" || task.id === values?.taskId),
    [tasks, values?.taskId],
  );

  if (!open || !values) return null;

  const isEdit = Boolean(values.ownerId);
  const heading =
    values.kind === "slot"
      ? isEdit
        ? "Edit time slot"
        : "Add time slot"
      : isEdit
        ? "Edit time block"
        : "Add time block";

  const update = <K extends keyof BlockEditorValues>(key: K, value: BlockEditorValues[K]) => {
    setValues((current) => (current ? { ...current, [key]: value } : current));
  };

  const submit = async () => {
    setLocalError(null);
    if (!values.title.trim()) {
      setLocalError("Title is required.");
      return;
    }
    const startMin = civilTimeToMinutes(values.start);
    const endMin = civilTimeToMinutes(values.end);
    if (startMin === null || endMin === null || endMin <= startMin) {
      setLocalError("End time must be after start time on the same day.");
      return;
    }
    const ok = await onSave({
      ...values,
      title: values.title.trim(),
      start: normalizeCivilTime(values.start),
      end: normalizeCivilTime(values.end),
    });
    if (!ok) setLocalError(error ?? "The change could not be saved.");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl border border-border bg-surface shadow-2xl"
        data-testid="timeblocking-editor-dialog"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-on-surface">
            {heading}
          </h2>
          {values.seriesEdit && (
            <p className="mt-1 text-xs text-warning" data-testid="series-edit-notice">
              Editing the recurring series owner. Phase 3 has no single-occurrence exceptions.
            </p>
          )}
        </div>

        <div className="space-y-3 px-4 py-3">
          <label className="block text-xs text-on-surface-secondary">
            Title
            <input
              type="text"
              value={values.title}
              onChange={(event) => update("title", event.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
              data-testid="editor-title"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-on-surface-secondary col-span-1">
              Date
              <input
                type="date"
                value={values.date}
                onChange={(event) => update("date", event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                data-testid="editor-date"
              />
            </label>
            <label className="block text-xs text-on-surface-secondary">
              Start
              <input
                type="time"
                value={normalizeCivilTime(values.start)}
                onChange={(event) => update("start", event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                data-testid="editor-start"
              />
            </label>
            <label className="block text-xs text-on-surface-secondary">
              End
              <input
                type="time"
                value={normalizeCivilTime(values.end)}
                onChange={(event) => update("end", event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                data-testid="editor-end"
              />
            </label>
          </div>

          <fieldset>
            <legend className="text-xs text-on-surface-secondary">Color</legend>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {COLOR_OPTIONS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Color ${color}`}
                  aria-pressed={values.color === color}
                  className={`h-6 w-6 rounded-full border ${
                    values.color === color ? "ring-2 ring-focus ring-offset-1" : "border-border"
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => update("color", color)}
                />
              ))}
            </div>
          </fieldset>

          {values.kind === "block" && (
            <>
              <label className="block text-xs text-on-surface-secondary">
                Linked task
                <select
                  value={values.taskId ?? ""}
                  onChange={(event) => update("taskId", event.target.value || null)}
                  className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  data-testid="editor-task"
                >
                  <option value="">None</option>
                  {pendingTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-on-surface-secondary">
                Slot
                <select
                  value={values.slotId ?? ""}
                  onChange={(event) => update("slotId", event.target.value || null)}
                  className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  data-testid="editor-slot"
                >
                  <option value="">None</option>
                  {slots.map((slot) => (
                    <option key={slot.occurrence_key} value={slot.id}>
                      {slot.title} ({slot.date})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-on-surface">
                <input
                  type="checkbox"
                  checked={values.locked}
                  onChange={(event) => update("locked", event.target.checked)}
                  data-testid="editor-locked"
                />
                Locked (skipped by automatic replan)
              </label>
            </>
          )}

          {values.kind === "slot" && (
            <label className="block text-xs text-on-surface-secondary">
              Project
              <select
                value={values.projectId ?? ""}
                onChange={(event) => update("projectId", event.target.value || null)}
                className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                data-testid="editor-project"
              >
                <option value="">None</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block text-xs text-on-surface-secondary">
            Recurrence
            <select
              value={values.recurrenceRule ?? ""}
              onChange={(event) => update("recurrenceRule", event.target.value || null)}
              className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              data-testid="editor-recurrence"
            >
              {RECURRENCE_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.value ?? ""}>
                  {preset.label}
                </option>
              ))}
            </select>
            {values.recurrenceRule && (
              <span className="mt-1 block text-[11px] text-on-surface-muted">
                {formatRecurrenceLabel(values.recurrenceRule)}
              </span>
            )}
          </label>

          {(localError || error) && (
            <div
              role="alert"
              className="rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
            >
              {localError ?? error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <div>
            {isEdit && onDelete && (
              <button
                type="button"
                disabled={pending}
                data-testid="editor-delete"
                onClick={() => void onDelete(values)}
                className="rounded-md px-3 py-1.5 text-sm text-error hover:bg-error/10 disabled:opacity-50"
              >
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              data-testid="editor-save"
              onClick={() => void submit()}
              className="rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
