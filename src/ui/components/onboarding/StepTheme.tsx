import { Check } from "lucide-react";
import { ACCENT_COLORS, THEME_OPTIONS } from "./constants.js";
import type { ThemeId } from "./types.js";

export function StepTheme({
  selectedTheme,
  selectedAccent,
  onThemeSelect,
  onAccentSelect,
}: {
  selectedTheme: ThemeId;
  selectedAccent: string;
  onThemeSelect: (id: ThemeId) => void;
  onAccentSelect: (color: string) => void;
}) {
  return (
    <div>
      <h2 className="text-[22px] font-bold text-on-surface text-center font-[Plus_Jakarta_Sans,sans-serif]">
        Pick your look
      </h2>
      <p className="text-sm text-on-surface-muted text-center mt-1 mb-6">
        Choose a theme and accent color
      </p>

      {/* Theme cards - accessible radio group */}
      <div
        role="radiogroup"
        aria-label="Theme selection"
        className="flex gap-3 justify-center mb-5"
      >
        {THEME_OPTIONS.map((theme) => {
          const Icon = theme.icon;
          const isSelected = selectedTheme === theme.id;
          return (
            <button
              key={theme.id}
              role="radio"
              aria-checked={isSelected}
              onClick={() => onThemeSelect(theme.id)}
              className={`w-[130px] rounded-2xl border-2 p-3 flex flex-col items-center justify-center gap-2 transition-all hover:scale-[1.02] ${theme.cardBg} ${
                isSelected
                  ? "border-accent shadow-md"
                  : "border-transparent hover:border-on-surface-muted/20"
              }`}
            >
              <Icon size={28} className={theme.iconColor} />
              <span className={`text-sm font-semibold ${theme.labelColor}`}>{theme.label}</span>
              {/* Mini mock with 3 bars */}
              <div className={`w-[90px] ${theme.mockBg} rounded-lg p-1.5 flex flex-col gap-1`}>
                <div className={`${theme.barColor} rounded-sm h-1.5 w-full`} />
                <div className={`${theme.barColor} rounded-sm h-1.5 w-[65%]`} />
                <div className={`${theme.accentBar} rounded-sm h-1.5 w-[45%]`} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Accent color picker - accessible radio group */}
      <div>
        <p className="text-[13px] font-medium text-on-surface-muted mb-2.5" id="accent-color-label">
          Accent color
        </p>
        <div
          role="radiogroup"
          aria-labelledby="accent-color-label"
          className="flex items-center gap-2.5 flex-wrap"
        >
          {ACCENT_COLORS.map((color) => {
            const isSelected = selectedAccent === color;
            return (
              <button
                key={color}
                role="radio"
                aria-checked={isSelected}
                aria-label={`Accent color ${color}`}
                onClick={() => onAccentSelect(color)}
                className={`rounded-full flex items-center justify-center transition-all ${
                  isSelected
                    ? "w-8 h-8 ring-2 ring-offset-2 ring-offset-surface ring-current"
                    : "w-7 h-7 hover:scale-110"
                }`}
                style={{ backgroundColor: color }}
              >
                {isSelected && <Check size={14} className="text-white drop-shadow" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
