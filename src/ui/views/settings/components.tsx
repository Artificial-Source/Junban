import { Check } from "lucide-react";

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface-secondary p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`density-button text-sm rounded-md transition-colors ${
            value === opt.value
              ? "bg-accent text-white shadow-sm"
              : "text-on-surface-secondary hover:text-on-surface"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function ColorSwatchPicker({
  colors,
  value,
  onChange,
}: {
  colors: readonly string[];
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {colors.map((color) => (
        <button
          key={color}
          onClick={() => onChange(color)}
          aria-label={`Accent color ${color}`}
          className={`density-swatch rounded-full flex items-center justify-center transition-all ${
            value === color
              ? "ring-2 ring-offset-2 ring-offset-surface ring-on-surface"
              : "hover:scale-110"
          }`}
          style={{ backgroundColor: color }}
        >
          {value === color && <Check size={14} className="text-white drop-shadow" />}
        </button>
      ))}
    </div>
  );
}

export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="density-row flex items-center justify-between">
      <div className="min-w-0">
        <p className="text-sm text-on-surface">{label}</p>
        {description && <p className="text-xs text-on-surface-muted">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

export function SettingSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="density-select text-sm border border-border rounded-lg bg-surface text-on-surface"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`density-toggle relative inline-flex items-center rounded-full transition-colors ${
        enabled ? "bg-accent" : "bg-surface-tertiary"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <span
        className="density-toggle-knob inline-block rounded-full bg-white transition-transform"
        style={{
          transform: enabled
            ? "translateX(calc(var(--density-toggle-width) - var(--density-toggle-knob-size) - 0.125rem))"
            : "translateX(0.125rem)",
        }}
      />
    </button>
  );
}
