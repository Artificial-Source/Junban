import { useState, useRef, useEffect } from "react";
import { Repeat, X } from "lucide-react";
import type { RecurrenceRule } from "../types.js";

interface RecurrenceEditorProps {
  rule: RecurrenceRule | undefined;
  onChange: (rule: RecurrenceRule | undefined) => void;
}

const FREQUENCY_OPTIONS: Array<{ value: RecurrenceRule["frequency"] | "none" | "custom"; label: string }> = [
  { value: "none", label: "None" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function RecurrenceEditor({ rule, onChange }: RecurrenceEditorProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Derived state from the rule
  const frequency = rule?.frequency ?? "none";
  const interval = rule?.interval ?? 1;
  const daysOfWeek = rule?.daysOfWeek ?? [];
  const endDate = rule?.endDate ?? "";
  const isCustom = rule ? rule.interval > 1 && rule.frequency !== "monthly" : false;
  const displayFrequency = !rule ? "none" : isCustom ? "custom" : rule.frequency;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleFrequencyChange = (value: string) => {
    if (value === "none") {
      onChange(undefined);
      return;
    }
    if (value === "custom") {
      onChange({ frequency: "daily", interval: 2, daysOfWeek: undefined, endDate: rule?.endDate });
      return;
    }
    const freq = value as RecurrenceRule["frequency"];
    onChange({
      frequency: freq,
      interval: 1,
      daysOfWeek: freq === "weekly" ? (daysOfWeek.length > 0 ? daysOfWeek : [new Date().getDay()]) : undefined,
      endDate: rule?.endDate,
    });
  };

  const handleIntervalChange = (newInterval: number) => {
    if (!rule || newInterval < 1) return;
    onChange({ ...rule, interval: newInterval });
  };

  const handleDayToggle = (day: number) => {
    if (!rule) return;
    const current = new Set(daysOfWeek);
    if (current.has(day)) {
      current.delete(day);
      if (current.size === 0) return; // Must have at least one day
    } else {
      current.add(day);
    }
    onChange({ ...rule, daysOfWeek: Array.from(current).sort((a, b) => a - b) });
  };

  const handleEndDateChange = (value: string) => {
    if (!rule) return;
    onChange({ ...rule, endDate: value || undefined });
  };

  const label = !rule
    ? "No repeat"
    : rule.frequency === "daily" && rule.interval === 1
      ? "Daily"
      : rule.frequency === "weekly" && rule.interval === 1
        ? `Weekly (${(rule.daysOfWeek ?? []).map((d) => DAY_LABELS[d]).join(", ")})`
        : rule.frequency === "monthly" && rule.interval === 1
          ? "Monthly"
          : `Every ${rule.interval} ${rule.frequency === "daily" ? "days" : rule.frequency === "weekly" ? "weeks" : "months"}`;

  return (
    <div className="relative" data-testid="recurrence-editor">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border transition-colors ${
          rule
            ? "border-accent/30 bg-accent/10 text-accent"
            : "border-border bg-surface-secondary text-on-surface-secondary hover:bg-surface-tertiary"
        }`}
        data-testid="recurrence-trigger"
      >
        <Repeat size={12} />
        <span>{label}</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-full left-0 mt-1 z-50 w-64 bg-surface border border-border rounded-lg shadow-lg p-3 space-y-3"
          data-testid="recurrence-popover"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-on-surface">Repeat</span>
            <button
              onClick={() => setOpen(false)}
              className="p-0.5 rounded hover:bg-surface-secondary text-on-surface-muted"
            >
              <X size={14} />
            </button>
          </div>

          {/* Frequency selector */}
          <div className="space-y-1.5">
            <label className="text-xs text-on-surface-secondary">Frequency</label>
            <select
              value={displayFrequency}
              onChange={(e) => handleFrequencyChange(e.target.value)}
              className="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="recurrence-frequency"
            >
              {FREQUENCY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Custom interval */}
          {displayFrequency === "custom" && rule && (
            <div className="space-y-1.5">
              <label className="text-xs text-on-surface-secondary">Every</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={interval}
                  onChange={(e) => handleIntervalChange(parseInt(e.target.value, 10) || 1)}
                  className="w-16 text-sm px-2 py-1.5 rounded-md border border-border bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
                  data-testid="recurrence-interval"
                />
                <select
                  value={rule.frequency}
                  onChange={(e) => onChange({ ...rule, frequency: e.target.value as RecurrenceRule["frequency"] })}
                  className="flex-1 text-sm px-2 py-1.5 rounded-md border border-border bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
                  data-testid="recurrence-custom-unit"
                >
                  <option value="daily">days</option>
                  <option value="weekly">weeks</option>
                </select>
              </div>
            </div>
          )}

          {/* Day of week checkboxes (weekly mode) */}
          {rule && (frequency === "weekly" || (displayFrequency === "custom" && rule.frequency === "weekly")) && (
            <div className="space-y-1.5">
              <label className="text-xs text-on-surface-secondary">On days</label>
              <div className="flex gap-1" data-testid="recurrence-days">
                {DAY_LABELS.map((label, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleDayToggle(idx)}
                    className={`w-8 h-8 text-xs rounded-md font-medium transition-colors ${
                      (rule.daysOfWeek ?? []).includes(idx)
                        ? "bg-accent text-white"
                        : "bg-surface-secondary text-on-surface-secondary hover:bg-surface-tertiary"
                    }`}
                    data-testid={`recurrence-day-${idx}`}
                  >
                    {label.charAt(0)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* End date */}
          {rule && (
            <div className="space-y-1.5">
              <label className="text-xs text-on-surface-secondary">End date (optional)</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => handleEndDateChange(e.target.value)}
                className="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid="recurrence-end-date"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Dialog for editing recurring block instances — "this occurrence" vs "all future". */
export function RecurrenceEditDialog({
  mode,
  onChoice,
  onCancel,
}: {
  mode: "edit" | "delete";
  onChoice: (choice: "this" | "all") => void;
  onCancel: () => void;
}) {
  const title = mode === "edit" ? "Edit Recurring Block" : "Delete Recurring Block";
  const thisLabel = mode === "edit" ? "Edit this occurrence" : "Delete this occurrence";
  const allLabel = mode === "edit" ? "Edit all future occurrences" : "Delete all occurrences";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="recurrence-dialog">
      <div className="bg-surface border border-border rounded-lg shadow-xl p-4 w-80 space-y-4">
        <h3 className="text-sm font-semibold text-on-surface">{title}</h3>
        <div className="space-y-2">
          <button
            onClick={() => onChoice("this")}
            className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-surface-secondary text-on-surface transition-colors"
            data-testid="recurrence-choice-this"
          >
            {thisLabel}
          </button>
          <button
            onClick={() => onChoice("all")}
            className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-surface-secondary text-on-surface transition-colors"
            data-testid="recurrence-choice-all"
          >
            {allLabel}
          </button>
        </div>
        <button
          onClick={onCancel}
          className="w-full px-3 py-1.5 text-sm rounded-md border border-border text-on-surface-secondary hover:bg-surface-secondary transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
