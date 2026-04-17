import React, { useState, useRef, useEffect, useMemo } from "react";
import { Plus, Flag, Hash, Calendar, FolderOpen, Repeat, Clock } from "lucide-react";
import type { ParsedTask } from "../../parser/task-parser.js";
import { formatRecurrenceLabel } from "./RecurrencePicker.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { DatePicker } from "./DatePicker.js";
import { TagsInput } from "./TagsInput.js";

const PRIORITY_MAP: Record<string, number> = { p1: 1, p2: 2, p3: 3, p4: 4 };

interface TaskInputProps {
  onSubmit: (input: ParsedTask) => void;
  placeholder?: string;
  autoFocusTrigger?: number;
  defaultDueDate?: Date;
}

function applyOverrides(
  parsed: ParsedTask,
  overrides: {
    priority?: number | null;
    dueDate?: string | null;
    tags?: string[];
  },
): ParsedTask {
  return {
    ...parsed,
    priority: overrides.priority !== undefined ? overrides.priority : parsed.priority,
    dueDate:
      overrides.dueDate !== undefined
        ? overrides.dueDate
          ? new Date(overrides.dueDate)
          : null
        : parsed.dueDate,
    dueTime: overrides.dueDate !== undefined ? false : parsed.dueTime,
    tags: overrides.tags !== undefined ? overrides.tags : parsed.tags,
  };
}

function formatQuickDateLabel(value: string | null | undefined): string {
  if (!value) return "Date";
  const date = new Date(value);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const toKey = (d: Date) => d.toISOString().slice(0, 10);
  const key = toKey(date);
  if (key === toKey(today)) return "Today";
  if (key === toKey(tomorrow)) return "Tomorrow";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

let parseTaskLoader: Promise<typeof import("../../parser/task-parser.js")> | null = null;

async function loadTaskParser() {
  if (!parseTaskLoader) {
    parseTaskLoader = import("../../parser/task-parser.js");
  }
  return parseTaskLoader;
}

export function TaskInput({
  onSubmit,
  placeholder,
  autoFocusTrigger,
  defaultDueDate,
}: TaskInputProps) {
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<ParsedTask | null>(null);
  const [focused, setFocused] = useState(false);
  const [manualPriority, setManualPriority] = useState<number | null | undefined>(undefined);
  const [manualDueDate, setManualDueDate] = useState<string | null | undefined>(undefined);
  const [manualTags, setManualTags] = useState<string[] | undefined>(undefined);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTagsEditor, setShowTagsEditor] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dateButtonRef = useRef<HTMLButtonElement>(null);
  const { settings } = useGeneralSettings();

  const effectivePreview = useMemo(
    () =>
      preview
        ? applyOverrides(preview, {
            priority: manualPriority,
            dueDate: manualDueDate,
            tags: manualTags,
          })
        : null,
    [preview, manualPriority, manualDueDate, manualTags],
  );
  const toolbarVisible = focused || showDatePicker || showTagsEditor;

  useEffect(() => {
    if (autoFocusTrigger && autoFocusTrigger > 0) {
      inputRef.current?.focus();
    }
  }, [autoFocusTrigger]);

  useEffect(() => {
    if (!value.trim()) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    void loadTaskParser().then(({ parseTask }) => {
      if (!cancelled) {
        setPreview(parseTask(value));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [value]);

  useEffect(() => {
    const warmParser = () => {
      void loadTaskParser();
    };

    const input = inputRef.current;
    input?.addEventListener("focus", warmParser, { once: true });
    return () => {
      input?.removeEventListener("focus", warmParser);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;

    const { parseTask } = await loadTaskParser();
    const parsed = applyOverrides(parseTask(value), {
      priority: manualPriority,
      dueDate: manualDueDate,
      tags: manualTags,
    });
    // Apply default priority from settings if user didn't specify one
    if (parsed.priority === null && settings.default_priority !== "none") {
      parsed.priority = PRIORITY_MAP[settings.default_priority] ?? null;
    }
    // Apply default due date if parser found none
    if (parsed.dueDate === null && defaultDueDate) {
      parsed.dueDate = defaultDueDate;
    }
    onSubmit(parsed);
    setValue("");
    setPreview(null);
    setManualPriority(undefined);
    setManualDueDate(undefined);
    setManualTags(undefined);
    setShowDatePicker(false);
    setShowTagsEditor(false);
    setFocused(false);
  };

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        const nextTarget = e.relatedTarget as Node | null;
        if (nextTarget && formRef.current?.contains(nextTarget)) return;
        if (showDatePicker || showTagsEditor) return;
        setFocused(false);
      }}
      className="mb-4"
    >
      <div
        className={`overflow-hidden rounded-xl bg-surface transition-all ${
          toolbarVisible
            ? "border border-accent/40 shadow-[0_0_0_1px_rgba(59,130,246,0.10)]"
            : "border border-border"
        }`}
      >
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">
            <Plus size={18} />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder ?? 'Add a task... (e.g., "buy milk tomorrow p1 #groceries")'}
            className={`w-full pl-10 pr-4 py-2.5 bg-surface text-on-surface placeholder-on-surface-muted transition-shadow focus:outline-none ${
              toolbarVisible ? "border-none rounded-none" : "rounded-xl border-none"
            }`}
          />
        </div>
        {toolbarVisible && (
          <div className="border-t border-border/70 bg-surface-secondary/35 px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {[1, 2, 3, 4].map((priority) => {
                const active = (manualPriority ?? preview?.priority ?? null) === priority;
                return (
                  <button
                    key={priority}
                    type="button"
                    onClick={() => setManualPriority(active ? null : priority)}
                    className={`inline-flex min-w-[2.6rem] items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                      active
                        ? `border-priority-${priority} bg-priority-${priority}/15 text-priority-${priority} shadow-sm`
                        : "border-border/80 text-on-surface-secondary hover:border-border hover:bg-surface"
                    }`}
                  >
                    <Flag size={11} />P{priority}
                  </button>
                );
              })}
              <button
                ref={dateButtonRef}
                type="button"
                onClick={() => setShowDatePicker((prev) => !prev)}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                  (manualDueDate ?? preview?.dueDate?.toISOString() ?? null)
                    ? "border-accent/50 bg-accent/10 text-accent shadow-sm"
                    : "border-border/80 text-on-surface-secondary hover:border-border hover:bg-surface"
                }`}
              >
                <Calendar size={11} />
                {formatQuickDateLabel(manualDueDate ?? preview?.dueDate?.toISOString() ?? null)}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowTagsEditor((prev) => !prev);
                  setManualTags((current) => current ?? [...(effectivePreview?.tags ?? [])]);
                }}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                  (manualTags ?? preview?.tags ?? []).length > 0
                    ? "border-purple-500/50 bg-purple-500/10 text-purple-400 shadow-sm"
                    : "border-border/80 text-on-surface-secondary hover:border-border hover:bg-surface"
                }`}
              >
                <Hash size={11} />
                {(manualTags ?? preview?.tags ?? []).length > 0
                  ? `${(manualTags ?? preview?.tags ?? []).length} label${(manualTags ?? preview?.tags ?? []).length === 1 ? "" : "s"}`
                  : "Labels"}
              </button>
            </div>

            {showTagsEditor && (
              <div className="mt-2 rounded-lg border border-border/70 bg-surface px-2 py-2 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-on-surface-muted">
                    Labels
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowTagsEditor(false)}
                    className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
                  >
                    Done
                  </button>
                </div>
                <div className="min-w-0">
                  <TagsInput value={manualTags ?? []} onChange={setManualTags} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {showDatePicker && (
        <DatePicker
          value={manualDueDate ?? preview?.dueDate?.toISOString() ?? null}
          onChange={(date) => {
            setManualDueDate(date);
            setShowDatePicker(false);
          }}
          onClose={() => setShowDatePicker(false)}
          triggerRef={dateButtonRef}
        />
      )}
      {effectivePreview && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-1 text-xs">
          <span className="text-on-surface-secondary">{effectivePreview.title}</span>
          {effectivePreview.priority && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-medium bg-priority-${effectivePreview.priority}/15 text-priority-${effectivePreview.priority}`}
            >
              <Flag size={10} />P{effectivePreview.priority}
            </span>
          )}
          {effectivePreview.dueDate && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/15 text-accent">
              <Calendar size={10} />
              {effectivePreview.dueDate.toLocaleDateString()}
            </span>
          )}
          {effectivePreview.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-purple-500/15 text-purple-500"
            >
              <Hash size={10} />
              {tag}
            </span>
          ))}
          {effectivePreview.project && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-success/15 text-success">
              <FolderOpen size={10} />
              {effectivePreview.project}
            </span>
          )}
          {effectivePreview.recurrence && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-teal-500/15 text-teal-500 font-medium">
              <Repeat size={10} />
              {formatRecurrenceLabel(effectivePreview.recurrence)}
            </span>
          )}
          {effectivePreview.estimatedMinutes != null && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-sky-500/15 text-sky-500 font-medium">
              <Clock size={10} />
              {effectivePreview.estimatedMinutes < 60
                ? `${effectivePreview.estimatedMinutes}m`
                : `${Math.floor(effectivePreview.estimatedMinutes / 60)}h${effectivePreview.estimatedMinutes % 60 > 0 ? `${effectivePreview.estimatedMinutes % 60}m` : ""}`}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
