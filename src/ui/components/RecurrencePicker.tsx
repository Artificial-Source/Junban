/**
 * Compact recurrence picker matching the legacy control.
 * Values use the Phase 2/3 canonical grammar only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { everyNRule, formatRecurrenceLabel, RECURRENCE_PRESETS } from "../lib/recurrence";

interface RecurrencePickerProps {
  value: string | null;
  onChange: (recurrence: string | null) => void | Promise<void>;
  onClose: () => void;
  pending?: boolean;
}

export function RecurrencePicker({
  value,
  onChange,
  onClose,
  pending = false,
}: RecurrencePickerProps) {
  const [customN, setCustomN] = useState(2);
  const [customUnit, setCustomUnit] = useState<"day" | "week">("day");
  const [localPending, setLocalPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const busy = pending || localPending;

  const requestClose = useCallback(() => {
    if (!pendingRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) requestClose();
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [requestClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [requestClose]);

  const commit = async (recurrence: string | null) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setLocalPending(true);
    setError(null);
    try {
      await onChange(recurrence);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The recurrence could not be saved.");
    } finally {
      pendingRef.current = false;
      setLocalPending(false);
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Recurrence"
      aria-busy={busy || undefined}
      className="absolute z-50 mt-1 w-56 rounded-lg border border-border bg-surface p-3 shadow-lg"
    >
      <div className="space-y-0.5">
        {RECURRENCE_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            disabled={busy}
            onClick={() => void commit(preset.value)}
            className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              value === preset.value
                ? "bg-accent-action/10 font-medium text-accent-foreground"
                : "text-on-surface hover:bg-surface-secondary"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mt-2 border-t border-border pt-2">
        <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
          Custom
        </span>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-xs text-on-surface-secondary">Every</span>
          <input
            type="number"
            min={1}
            max={365}
            value={customN}
            disabled={busy}
            aria-label="Custom recurrence interval"
            onChange={(e) => setCustomN(Number.parseInt(e.target.value, 10) || 1)}
            className="w-12 rounded-md border border-border bg-surface-secondary px-1.5 py-1 text-center text-xs text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <select
            value={customUnit}
            disabled={busy}
            aria-label="Custom recurrence unit"
            onChange={(e) => setCustomUnit(e.target.value as "day" | "week")}
            className="rounded-md border border-border bg-surface-secondary px-1.5 py-1 text-xs text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
          >
            <option value="day">days</option>
            <option value="week">weeks</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => void commit(everyNRule(customN, customUnit))}
            className="rounded-md bg-accent-action px-2 py-1 text-xs text-on-accent-action transition-colors hover:bg-accent-action-hover"
          >
            Set
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
      {value && (
        <p className="mt-2 text-[10px] text-on-surface-muted">
          Current: {formatRecurrenceLabel(value)}
        </p>
      )}
    </div>
  );
}
