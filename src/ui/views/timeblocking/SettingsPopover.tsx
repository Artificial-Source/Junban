/**
 * Read-only Phase 3 temporal defaults popover (capacity/workday).
 * Mutable settings land in Phase 4.
 */
import { Settings, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_BLOCK_DURATION_MINUTES,
  DEFAULT_GRID_INTERVAL_MINUTES,
  DEFAULT_WORK_DAY_END,
  DEFAULT_WORK_DAY_START,
  normalizeCivilTime,
} from "./timeblockingRange";

interface SettingsPopoverProps {
  capacityMinutes: number | null;
  workDayStart?: string;
  workDayEnd?: string;
  timeZone?: string | null;
  weekStart?: string | null;
}

function formatHourOption(time: string): string {
  const [hRaw] = normalizeCivilTime(time).split(":");
  const h = Number(hRaw);
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
}

export function SettingsPopover({
  capacityMinutes,
  workDayStart = DEFAULT_WORK_DAY_START,
  workDayEnd = DEFAULT_WORK_DAY_END,
  timeZone,
  weekStart,
}: SettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rounded-md p-1.5 text-on-surface-secondary transition-colors hover:bg-surface-secondary"
        aria-label="Timeblocking settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="tb-settings-trigger"
      >
        <Settings size={16} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-labelledby={titleId}
          className="absolute right-0 top-full z-50 mt-1 w-60 space-y-3 rounded-lg border border-border bg-surface p-3 shadow-lg"
          data-testid="tb-settings-popover"
        >
          <div className="flex items-center justify-between">
            <span id={titleId} className="text-sm font-medium text-on-surface">
              Settings
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-on-surface-muted hover:bg-surface-secondary"
              aria-label="Close settings"
            >
              <X size={14} />
            </button>
          </div>
          <p className="text-[11px] text-on-surface-muted">
            Phase 3 uses fixed temporal defaults. Editable settings arrive in Phase 4.
          </p>
          <dl className="space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-on-surface-secondary">Work start</dt>
              <dd className="text-on-surface" data-testid="tb-setting-start">
                {formatHourOption(workDayStart)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-on-surface-secondary">Work end</dt>
              <dd className="text-on-surface" data-testid="tb-setting-end">
                {formatHourOption(workDayEnd)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-on-surface-secondary">Grid interval</dt>
              <dd className="text-on-surface" data-testid="tb-setting-grid">
                {DEFAULT_GRID_INTERVAL_MINUTES} min
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-on-surface-secondary">Default duration</dt>
              <dd className="text-on-surface" data-testid="tb-setting-duration">
                {DEFAULT_BLOCK_DURATION_MINUTES} min
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-on-surface-secondary">Daily capacity</dt>
              <dd className="text-on-surface" data-testid="tb-setting-capacity">
                {capacityMinutes != null ? `${capacityMinutes} min` : "—"}
              </dd>
            </div>
            {timeZone && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-on-surface-secondary">Time zone</dt>
                <dd className="truncate text-on-surface" title={timeZone}>
                  {timeZone}
                </dd>
              </div>
            )}
            {weekStart && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-on-surface-secondary">Week start</dt>
                <dd className="capitalize text-on-surface">{weekStart}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
