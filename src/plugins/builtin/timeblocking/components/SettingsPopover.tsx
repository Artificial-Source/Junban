import { useState, useRef, useEffect } from "react";
import { Settings, X } from "lucide-react";

interface SettingsPopoverProps {
  workDayStart: string;
  workDayEnd: string;
  gridInterval: string;
  defaultDuration: string;
  onSettingChange: (key: string, value: string) => void;
}

const WORK_START_OPTIONS = ["06:00", "07:00", "08:00", "09:00", "10:00"];
const WORK_END_OPTIONS = ["16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00"];
const GRID_OPTIONS = ["15", "30", "60"];
const DURATION_OPTIONS = ["15", "30", "45", "60", "90", "120"];

function formatTime(time: string): string {
  const [h] = time.split(":").map(Number);
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
}

function SettingRow({
  label,
  value,
  options,
  formatOption,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  options: string[];
  formatOption?: (opt: string) => string;
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="text-xs text-on-surface-secondary whitespace-nowrap">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs px-2 py-1 rounded-md border border-border bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
        data-testid={testId}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {formatOption ? formatOption(opt) : opt}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SettingsPopover({
  workDayStart,
  workDayEnd,
  gridInterval,
  defaultDuration,
  onSettingChange,
}: SettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 rounded-md hover:bg-surface-secondary text-on-surface-secondary transition-colors"
        aria-label="Timeblocking settings"
        data-testid="tb-settings-trigger"
      >
        <Settings size={16} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-full right-0 mt-1 z-50 w-56 bg-surface border border-border rounded-lg shadow-lg p-3 space-y-3"
          data-testid="tb-settings-popover"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-on-surface">Settings</span>
            <button
              onClick={() => setOpen(false)}
              className="p-0.5 rounded hover:bg-surface-secondary text-on-surface-muted"
            >
              <X size={14} />
            </button>
          </div>

          <SettingRow
            label="Work start"
            value={workDayStart}
            options={WORK_START_OPTIONS}
            formatOption={formatTime}
            onChange={(v) => onSettingChange("workDayStart", v)}
            testId="tb-setting-start"
          />
          <SettingRow
            label="Work end"
            value={workDayEnd}
            options={WORK_END_OPTIONS}
            formatOption={formatTime}
            onChange={(v) => onSettingChange("workDayEnd", v)}
            testId="tb-setting-end"
          />
          <SettingRow
            label="Grid interval"
            value={gridInterval}
            options={GRID_OPTIONS}
            formatOption={(v) => `${v} min`}
            onChange={(v) => onSettingChange("gridIntervalMinutes", v)}
            testId="tb-setting-grid"
          />
          <SettingRow
            label="Default duration"
            value={defaultDuration}
            options={DURATION_OPTIONS}
            formatOption={(v) => `${v} min`}
            onChange={(v) => onSettingChange("defaultDurationMinutes", v)}
            testId="tb-setting-duration"
          />
        </div>
      )}
    </div>
  );
}
