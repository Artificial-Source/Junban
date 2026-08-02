/**
 * Legacy Settings presentation primitives (SettingRow, segmented controls, swatches, toggles).
 */
import { createContext, useContext, useId, type ReactNode } from "react";
import { Check } from "lucide-react";

interface SettingRowContextValue {
  controlId: string;
  labelId: string;
  descriptionId?: string;
}

const SettingRowContext = createContext<SettingRowContextValue | null>(null);

export function SettingsSegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  optionRef,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  optionRef?: (value: T, element: HTMLInputElement | null) => void;
}) {
  const generatedName = useId();
  const row = useContext(SettingRowContext);

  return (
    <fieldset
      className="inline-flex rounded-lg border border-border bg-surface-secondary p-0.5"
      aria-labelledby={row?.labelId}
      aria-describedby={row?.descriptionId}
      disabled={disabled}
    >
      {!row && <legend className="sr-only">{label}</legend>}
      {options.map((opt) => {
        const optionId = `${generatedName}-${opt.value}`;
        return (
          <span key={opt.value} className="relative">
            <input
              id={optionId}
              type="radio"
              name={generatedName}
              value={opt.value}
              ref={(element) => optionRef?.(opt.value, element)}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className="peer sr-only"
            />
            <label
              htmlFor={optionId}
              className="block cursor-pointer rounded-md px-3 py-1.5 text-sm text-on-surface-secondary transition-colors hover:text-on-surface peer-checked:bg-surface peer-checked:text-on-surface peer-checked:shadow-sm peer-checked:ring-1 peer-checked:ring-accent-action peer-focus-visible:outline-2 peer-focus-visible:outline-solid peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-1 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
            >
              {opt.label}
            </label>
          </span>
        );
      })}
    </fieldset>
  );
}

export function ColorSwatchPicker({
  label,
  colors,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  colors: readonly string[];
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  const generatedName = useId();

  return (
    <fieldset disabled={disabled}>
      <legend className="mb-2 text-sm text-on-surface">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {colors.map((color, index) => {
          const optionId = `${generatedName}-${index}`;
          return (
            <span key={color} className="relative">
              <input
                id={optionId}
                type="radio"
                name={generatedName}
                value={color}
                checked={value.toLowerCase() === color.toLowerCase()}
                aria-label={`${label} ${color}`}
                onChange={() => onChange(color)}
                className="peer sr-only"
              />
              <label
                htmlFor={optionId}
                className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-110 peer-checked:ring-2 peer-checked:ring-on-surface peer-checked:ring-offset-2 peer-checked:ring-offset-surface peer-focus-visible:outline-2 peer-focus-visible:outline-solid peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full border border-on-surface/30"
                  style={{ backgroundColor: color }}
                />
                {value.toLowerCase() === color.toLowerCase() && (
                  <span
                    aria-hidden="true"
                    className="relative flex h-4 w-4 items-center justify-center rounded-full bg-surface text-on-surface shadow-sm"
                  >
                    <Check size={11} />
                  </span>
                )}
              </label>
            </span>
          );
        })}
      </div>
    </fieldset>
  );
}

export function SettingRow({
  label,
  description,
  group = false,
  controlId: explicitControlId,
  children,
}: {
  label: string;
  description?: string;
  group?: boolean;
  controlId?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const controlId = explicitControlId ?? `${generatedId}-control`;
  const labelId = `${generatedId}-label`;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const labelClassName = "text-sm text-on-surface";

  return (
    <SettingRowContext.Provider value={{ controlId, labelId, descriptionId }}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          {group ? (
            <p id={labelId} className={labelClassName}>
              {label}
            </p>
          ) : (
            <label id={labelId} htmlFor={controlId} className={labelClassName}>
              {label}
            </label>
          )}
          {description && (
            <p id={descriptionId} className="text-xs text-on-surface-muted">
              {description}
            </p>
          )}
        </div>
        <div className="flex-shrink-0">{children}</div>
      </div>
    </SettingRowContext.Provider>
  );
}

export function SettingSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  const generatedId = useId();
  const row = useContext(SettingRowContext);

  return (
    <select
      id={row?.controlId ?? generatedId}
      aria-label={row ? undefined : label}
      aria-describedby={row?.descriptionId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function SettingsToggle({
  enabled,
  onToggle,
  disabled = false,
  label,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label: string;
}) {
  const generatedId = useId();
  const row = useContext(SettingRowContext);
  const controlId = row?.controlId ?? generatedId;

  return (
    <label
      htmlFor={controlId}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-within:outline-2 focus-within:outline-solid focus-within:outline-offset-2 focus-within:outline-focus focus-within:ring-2 focus-within:ring-focus focus-within:ring-offset-2 focus-within:ring-offset-surface ${
        enabled ? "bg-accent-action" : "bg-surface-tertiary"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        id={controlId}
        type="checkbox"
        checked={enabled}
        disabled={disabled}
        aria-label={row ? undefined : label}
        aria-describedby={row?.descriptionId}
        onChange={onToggle}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          enabled ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </label>
  );
}

export function SettingsStatusBanner({
  kind,
  children,
}: {
  kind: "info" | "success" | "error" | "warning";
  children: ReactNode;
}) {
  const styles =
    kind === "success"
      ? "border-success/30 bg-success/10 text-on-surface"
      : kind === "error"
        ? "border-error/30 bg-error/10 text-on-surface"
        : kind === "warning"
          ? "border-border bg-surface-secondary text-on-surface"
          : "border-border bg-surface-secondary text-on-surface-secondary";
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`rounded-lg border px-3 py-2 text-sm ${styles}`}
    >
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-on-surface">{title}</h2>
      {description && <p className="mb-3 text-sm text-on-surface-muted">{description}</p>}
      <div className="max-w-md space-y-4">{children}</div>
    </section>
  );
}
