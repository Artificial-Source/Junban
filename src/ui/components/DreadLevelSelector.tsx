import { useCallback } from "react";

/** Dread level color scale: green -> yellow -> orange -> red -> dark red */
const DREAD_COLORS: Record<number, { fill: string; label: string; className: string }> = {
  1: { fill: "#22c55e", label: "Low dread", className: "text-green-500" },
  2: { fill: "#eab308", label: "Mild dread", className: "text-yellow-500" },
  3: { fill: "#f97316", label: "Moderate dread", className: "text-orange-500" },
  4: { fill: "#ef4444", label: "High dread", className: "text-red-500" },
  5: { fill: "#991b1b", label: "Maximum dread", className: "text-red-800" },
};

/**
 * Frog SVG icon used for dread level display.
 * Renders at the given size with the specified color.
 */
export function FrogIcon({
  size = 16,
  color = "currentColor",
  className = "",
}: {
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Frog body */}
      <path d="M12 18c-4 0-7-2-7-5s3-5 7-5 7 2 7 5-3 5-7 5z" />
      {/* Eyes */}
      <circle cx="8.5" cy="7" r="2" />
      <circle cx="15.5" cy="7" r="2" />
      {/* Pupils */}
      <circle cx="8.5" cy="7" r="0.8" fill={color} stroke="none" />
      <circle cx="15.5" cy="7" r="0.8" fill={color} stroke="none" />
      {/* Mouth */}
      <path d="M9 15c1 1 5 1 6 0" />
    </svg>
  );
}

/** Get the color info for a dread level (1-5). */
export function getDreadLevelColor(level: number) {
  return DREAD_COLORS[level] ?? DREAD_COLORS[1];
}

interface DreadLevelSelectorProps {
  value: number | null;
  onChange: (level: number | null) => void;
  compact?: boolean;
}

/**
 * Interactive dread level selector — 5 frog icons.
 * Click to set level; click same level again to clear.
 */
export function DreadLevelSelector({ value, onChange, compact = false }: DreadLevelSelectorProps) {
  const handleClick = useCallback(
    (level: number) => {
      onChange(value === level ? null : level);
    },
    [value, onChange],
  );

  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Dread level">
      {[1, 2, 3, 4, 5].map((level) => {
        const info = DREAD_COLORS[level];
        const isActive = value != null && level <= value;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={value === level}
            aria-label={`${info.label} (${level} of 5)`}
            onClick={() => handleClick(level)}
            className={`rounded-md transition-all duration-150 ${compact ? "p-0.5" : "p-1"} ${
              isActive ? "opacity-100 scale-110" : "opacity-30 hover:opacity-60"
            }`}
            title={info.label}
          >
            <FrogIcon size={compact ? 14 : 18} color={isActive ? info.fill : "currentColor"} />
          </button>
        );
      })}
    </div>
  );
}
