import React, { useState, useRef, useEffect } from "react";
import { Plus, Flag, Hash, Calendar, FolderOpen, Repeat, Clock } from "lucide-react";
import type { ParsedTask } from "../../parser/task-parser.js";
import { formatRecurrenceLabel } from "./RecurrencePicker.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

const PRIORITY_MAP: Record<string, number> = { p1: 1, p2: 2, p3: 3, p4: 4 };

interface TaskInputProps {
  onSubmit: (input: ParsedTask) => void;
  placeholder?: string;
  autoFocusTrigger?: number;
  defaultDueDate?: Date;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const { settings } = useGeneralSettings();

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
          {preview.estimatedMinutes != null && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-sky-500/15 text-sky-500 font-medium">
              <Clock size={10} />
              {preview.estimatedMinutes < 60
                ? `${preview.estimatedMinutes}m`
                : `${Math.floor(preview.estimatedMinutes / 60)}h${preview.estimatedMinutes % 60 > 0 ? `${preview.estimatedMinutes % 60}m` : ""}`}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
