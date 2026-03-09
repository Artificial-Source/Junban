import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface DatePickerProps {
  value: string | null;
  onChange: (date: string | null) => void;
  showTime?: boolean;
  onClose: () => void;
  /** Ref to the trigger element for positioning the portal */
  triggerRef?: React.RefObject<HTMLElement | null>;
  /** Fixed position for portal rendering without a trigger element (e.g. from context menu) */
  fixedPosition?: { x: number; y: number };
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function getMonthDays(year: number, month: number) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startDay = first.getDay();
  const totalDays = last.getDate();

  const cells: (number | null)[] = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);
  return cells;
}

function toDateStr(year: number, month: number, day: number): string {
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function DatePicker({
  value,
  onChange,
  showTime = false,
  onClose,
  triggerRef,
  fixedPosition,
}: DatePickerProps) {
  const now = new Date();
  const initialDate = value ? new Date(value) : now;
  const [viewYear, setViewYear] = useState(initialDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialDate.getMonth());
  const [timeValue, setTimeValue] = useState(value && showTime ? value.slice(11, 16) : "");
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const selectedDateStr = value ? value.split("T")[0] : null;

  // Compute fixed position from trigger element or fixedPosition prop
  useEffect(() => {
    const pickerHeight = showTime ? 380 : 330;
    const pickerWidth = 256; // w-64

    if (fixedPosition) {
      let top = fixedPosition.y;
      if (top + pickerHeight > window.innerHeight) {
        top = Math.max(4, window.innerHeight - pickerHeight - 4);
      }
      let left = fixedPosition.x;
      if (left + pickerWidth > window.innerWidth) {
        left = Math.max(4, window.innerWidth - pickerWidth - 8);
      }
      setPosition({ top, left });
      return;
    }

    if (!triggerRef?.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    // Position above the trigger if it would overflow the viewport bottom
    let top = rect.bottom + 4;
    if (top + pickerHeight > window.innerHeight) {
      top = rect.top - pickerHeight - 4;
    }
    // Clamp left so picker doesn't overflow right edge
    let left = rect.left;
    if (left + pickerWidth > window.innerWidth) {
      left = window.innerWidth - pickerWidth - 8;
    }
    setPosition({ top, left });
  }, [triggerRef, fixedPosition, showTime]);

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

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear(viewYear - 1);
      setViewMonth(11);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear(viewYear + 1);
      setViewMonth(0);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const handleDateSelect = useCallback(
    (day: number) => {
      const dateStr = toDateStr(viewYear, viewMonth, day);
      if (showTime && timeValue) {
        onChange(`${dateStr}T${timeValue}:00`);
      } else {
        onChange(`${dateStr}T00:00:00`);
      }
    },
    [viewYear, viewMonth, showTime, timeValue, onChange],
  );

  const handleQuickOption = (date: Date | null) => {
    if (!date) {
      onChange(null);
      return;
    }
    const dateStr = toDateStr(date.getFullYear(), date.getMonth(), date.getDate());
    onChange(`${dateStr}T00:00:00`);
  };

  const cells = getMonthDays(viewYear, viewMonth);
  const today = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const tomorrow = addDays(now, 1);
  const nextWeek = addDays(now, 7 - now.getDay() + 1); // Next Monday

  const usePortal = fixedPosition != null || triggerRef != null;

  const picker = (
    <div
      ref={ref}
      className={`${usePortal ? "fixed" : "absolute right-0 mt-1"} z-50 bg-surface border border-border rounded-lg shadow-lg p-3 w-64`}
      style={usePortal && position ? { top: position.top, left: position.left } : undefined}
    >
      {/* Quick options */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        <button
          onClick={() => handleQuickOption(now)}
          className="text-xs px-2 py-1 rounded-md bg-surface-secondary text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
        >
          Today
        </button>
        <button
          onClick={() => handleQuickOption(tomorrow)}
          className="text-xs px-2 py-1 rounded-md bg-surface-secondary text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
        >
          Tomorrow
        </button>
        <button
          onClick={() => handleQuickOption(nextWeek)}
          className="text-xs px-2 py-1 rounded-md bg-surface-secondary text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
        >
          Next week
        </button>
        <button
          onClick={() => handleQuickOption(null)}
          className="text-xs px-2 py-1 rounded-md bg-surface-secondary text-on-surface-muted hover:bg-surface-tertiary transition-colors"
        >
          No date
        </button>
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={prevMonth}
          className="p-1 rounded hover:bg-surface-secondary text-on-surface-muted hover:text-on-surface transition-colors"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-sm font-medium text-on-surface">{monthLabel}</span>
        <button
          onClick={nextMonth}
          className="p-1 rounded hover:bg-surface-secondary text-on-surface-muted hover:text-on-surface transition-colors"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {DAYS.map((d) => (
          <div key={d} className="text-center text-xs text-on-surface-muted font-medium py-0.5">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, i) => {
          if (day === null) {
            return <div key={`empty-${i}`} />;
          }
          const dateStr = toDateStr(viewYear, viewMonth, day);
          const isToday = dateStr === today;
          const isSelected = dateStr === selectedDateStr;

          return (
            <button
              key={day}
              onClick={() => handleDateSelect(day)}
              className={`text-xs w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
                isSelected
                  ? "bg-accent text-white"
                  : isToday
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-on-surface hover:bg-surface-secondary"
              }`}
            >
              {day}
            </button>
          );
        })}
      </div>

      {/* Optional time input */}
      {showTime && (
        <div className="mt-2 pt-2 border-t border-border">
          <label className="text-xs text-on-surface-muted">Time</label>
          <input
            type="time"
            value={timeValue}
            onChange={(e) => setTimeValue(e.target.value)}
            className="w-full mt-0.5 px-2 py-1 text-sm bg-surface-secondary border border-border rounded-md text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      )}
    </div>
  );

  return usePortal ? createPortal(picker, document.body) : picker;
}
