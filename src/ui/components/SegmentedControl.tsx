/**
 * Accessible radio-group segmented control used by Calendar and Stats.
 * Preserves the legacy settings SegmentedControl presentation.
 */
import { useId } from "react";

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();

  return (
    <fieldset
      className="inline-flex rounded-lg border border-border bg-surface-secondary p-0.5"
      disabled={disabled}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((opt) => {
        const optionId = `${name}-${opt.value}`;
        return (
          <span key={opt.value} className="relative">
            <input
              id={optionId}
              type="radio"
              name={name}
              value={opt.value}
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
