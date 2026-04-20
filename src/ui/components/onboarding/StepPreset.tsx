import { PRESET_OPTIONS } from "./constants.js";
import type { Preset } from "./types.js";

export function StepPreset({
  selectedPreset,
  onPresetSelect,
}: {
  selectedPreset: Preset;
  onPresetSelect: (preset: Preset) => void;
}) {
  return (
    <div>
      <h2 className="text-[22px] font-bold text-on-surface text-center font-[Plus_Jakarta_Sans,sans-serif]">
        How much do you want to see?
      </h2>
      <p className="text-sm text-on-surface-muted text-center mt-1 mb-6">
        Start simple. You can always add more later in Settings.
      </p>
      {/* Accessible radio group for preset selection */}
      <div role="radiogroup" aria-label="Feature preset selection" className="space-y-3">
        {PRESET_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = selectedPreset === option.key;
          return (
            <button
              key={option.key}
              role="radio"
              aria-checked={isSelected}
              onClick={() => onPresetSelect(option.key)}
              className={`w-full flex items-center gap-3.5 px-4 py-4 rounded-[14px] border-2 text-left transition-all hover:scale-[1.01] ${
                isSelected ? "border-accent" : "border-border hover:border-on-surface-muted/30"
              }`}
            >
              {/* Radio dot with visual selected state */}
              <div
                aria-hidden="true"
                className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
                  isSelected
                    ? "border-[6px] border-accent bg-white"
                    : "border-2 border-on-surface-muted/30 bg-white"
                }`}
              />

              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-on-surface">{option.label}</p>
                <p className="text-[13px] text-on-surface-muted mt-0.5">{option.description}</p>
              </div>

              <Icon
                size={20}
                className={`flex-shrink-0 ${isSelected ? "text-accent" : "text-on-surface-muted"}`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
