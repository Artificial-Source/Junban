import React, { useState, useMemo, useRef, useEffect } from "react";
import { Plus, Flag, Hash, Calendar, FolderOpen, Repeat } from "lucide-react";
import { parseTask } from "../../parser/task-parser.js";
import { formatRecurrenceLabel } from "./RecurrencePicker.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

const PRIORITY_MAP: Record<string, number> = { p1: 1, p2: 2, p3: 3, p4: 4 };

interface TaskInputProps {
  onSubmit: (input: ReturnType<typeof parseTask>) => void;
  placeholder?: string;
  autoFocusTrigger?: number;
  defaultDueDate?: Date;
}

export function TaskInput({
  onSubmit,
  placeholder,
  autoFocusTrigger,
  defaultDueDate,
}: TaskInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { settings } = useGeneralSettings();

  useEffect(() => {
    if (autoFocusTrigger && autoFocusTrigger > 0) {
      inputRef.current?.focus();
    }
  }, [autoFocusTrigger]);

  const preview = useMemo(() => {
    if (!value.trim()) return null;
    return parseTask(value);
  }, [value]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;

    const parsed = parseTask(value);
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
  };

  return (
    <form onSubmit={handleSubmit} className="mb-4">
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
          className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-shadow"
        />
      </div>
      {preview && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-1 text-xs">
          <span className="text-on-surface-secondary">{preview.title}</span>
          {preview.priority && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-medium bg-priority-${preview.priority}/15 text-priority-${preview.priority}`}
            >
              <Flag size={10} />P{preview.priority}
            </span>
          )}
          {preview.dueDate && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/15 text-accent">
              <Calendar size={10} />
              {preview.dueDate.toLocaleDateString()}
            </span>
          )}
          {preview.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-purple-500/15 text-purple-500"
            >
              <Hash size={10} />
              {tag}
            </span>
          ))}
          {preview.project && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-success/15 text-success">
              <FolderOpen size={10} />
              {preview.project}
            </span>
          )}
          {preview.recurrence && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-teal-500/15 text-teal-500 font-medium">
              <Repeat size={10} />
              {formatRecurrenceLabel(preview.recurrence)}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
