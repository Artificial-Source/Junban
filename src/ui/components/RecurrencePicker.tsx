import { useState, useRef, useEffect } from "react";

interface RecurrencePickerProps {
  value: string | null;
  onChange: (recurrence: string | null) => void;
  onClose: () => void;
}

const PRESETS = [
  { label: "None", value: null },
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" },
  { label: "Weekdays", value: "weekdays" },
] as const;

export function RecurrencePicker({ value, onChange, onClose }: RecurrencePickerProps) {
  const [customN, setCustomN] = useState(2);
  const [customUnit, setCustomUnit] = useState<"day" | "week">("day");
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handlePreset = (preset: (typeof PRESETS)[number]) => {
    onChange(preset.value);
  };

  const handleCustomApply = () => {
    const n = Math.max(1, Math.floor(customN));
    const unit = customUnit === "day" ? (n === 1 ? "day" : "days") : n === 1 ? "week" : "weeks";
    onChange(`every ${n} ${unit}`);
  };

  return (
    <div
      ref={ref}
      className="absolute z-50 mt-1 bg-surface border border-border rounded-lg shadow-lg p-3 w-56"
    >
      {/* Presets */}
      <div className="space-y-0.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => handlePreset(preset)}
            className={`w-full text-left text-sm px-2 py-1.5 rounded-md transition-colors ${
              value === preset.value
                ? "bg-accent/10 text-accent font-medium"
                : "text-on-surface hover:bg-surface-secondary"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Custom "Every N" */}
      <div className="border-t border-border mt-2 pt-2">
        <span className="text-xs text-on-surface-muted font-medium uppercase tracking-wider">
          Custom
        </span>
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="text-xs text-on-surface-secondary">Every</span>
          <input
            type="number"
            min={1}
            max={365}
            value={customN}
            onChange={(e) => setCustomN(parseInt(e.target.value, 10) || 1)}
            className="w-12 px-1.5 py-1 text-xs bg-surface-secondary border border-border rounded-md text-on-surface text-center focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <select
            value={customUnit}
            onChange={(e) => setCustomUnit(e.target.value as "day" | "week")}
            className="px-1.5 py-1 text-xs bg-surface-secondary border border-border rounded-md text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="day">days</option>
            <option value="week">weeks</option>
          </select>
          <button
            onClick={handleCustomApply}
            className="px-2 py-1 text-xs bg-accent text-white rounded-md hover:bg-accent/90 transition-colors"
          >
            Set
          </button>
        </div>
      </div>
    </div>
  );
}

/** Format a recurrence string into a human-readable label. */
export function formatRecurrenceLabel(recurrence: string): string {
  switch (recurrence) {
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "weekdays":
      return "Weekdays";
    default: {
      const match = recurrence.match(/^every\s+(\d+)\s+(day|week)s?$/);
      if (match) {
        const n = parseInt(match[1], 10);
        const unit = match[2];
        if (n === 1) return unit === "day" ? "Daily" : "Weekly";
        return `Every ${n} ${unit}s`;
      }
      return recurrence;
    }
  }
}
