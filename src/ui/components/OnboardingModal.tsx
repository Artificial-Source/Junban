import { useState, useCallback } from "react";
import { themeManager } from "../themes/manager.js";
import { useGeneralSettings, type GeneralSettings } from "../context/SettingsContext.js";
import { PRESETS, TOTAL_STEPS } from "./onboarding/constants.js";
import { StepWelcome } from "./onboarding/StepWelcome.js";
import { StepTheme } from "./onboarding/StepTheme.js";
import { StepPreset } from "./onboarding/StepPreset.js";
import { StepAI } from "./onboarding/StepAI.js";
import { StepReady } from "./onboarding/StepReady.js";
import type { OnboardingModalProps, ThemeId, Preset } from "./onboarding/types.js";

export function OnboardingModal({ open, onComplete, onRequestOpenSettings }: OnboardingModalProps) {
  const [step, setStep] = useState(0);
  const [selectedTheme, setSelectedTheme] = useState<ThemeId>("light");
  const [selectedAccent, setSelectedAccent] = useState("#3b82f6");
  const [selectedPreset, setSelectedPreset] = useState<Preset>("minimal");
  const [wantsAI, setWantsAI] = useState(false);

  const { updateSetting } = useGeneralSettings();

  const handleNext = useCallback(() => {
    if (step < TOTAL_STEPS - 1) {
      setStep((s) => s + 1);
    }
  }, [step]);

  const handleBack = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const handleThemeSelect = useCallback(
    (themeId: ThemeId) => {
      setSelectedTheme(themeId);
      themeManager.setTheme(themeId);
    },
    [],
  );

  const handleAccentSelect = useCallback(
    (color: string) => {
      setSelectedAccent(color);
      updateSetting("accent_color", color);
    },
    [updateSetting],
  );

  const handleFinish = useCallback(() => {
    // Apply preset feature flags
    const preset = PRESETS[selectedPreset];
    for (const [key, value] of Object.entries(preset)) {
      updateSetting(key as keyof GeneralSettings, value as GeneralSettings[keyof GeneralSettings]);
    }

    // Theme and accent are already applied live, but ensure they're persisted
    themeManager.setTheme(selectedTheme);
    updateSetting("accent_color", selectedAccent);

    onComplete();

    if (wantsAI) {
      onRequestOpenSettings?.("ai");
    }
  }, [selectedPreset, selectedTheme, selectedAccent, wantsAI, updateSetting, onComplete, onRequestOpenSettings]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 bg-surface rounded-[20px] shadow-2xl border border-border animate-scale-fade-in px-9 py-8">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-accent" : "w-1.5 bg-surface-tertiary"
              }`}
            />
          ))}
        </div>

        {/* Step content */}
        {step === 0 && <StepWelcome />}
        {step === 1 && (
          <StepTheme
            selectedTheme={selectedTheme}
            selectedAccent={selectedAccent}
            onThemeSelect={handleThemeSelect}
            onAccentSelect={handleAccentSelect}
          />
        )}
        {step === 2 && (
          <StepPreset selectedPreset={selectedPreset} onPresetSelect={setSelectedPreset} />
        )}
        {step === 3 && <StepAI onSetWantsAI={setWantsAI} onNext={handleNext} />}
        {step === 4 && <StepReady />}

        {/* Actions — Step 0: centered button, Steps 1-2: Back/Next, Step 3: own buttons, Step 4: centered finish */}
        <div className="flex justify-between items-center mt-8">
          {step === 0 && (
            <>
              <div />
              <button
                onClick={handleNext}
                className="px-8 py-2.5 text-sm font-semibold bg-accent text-white rounded-xl hover:bg-accent/90 transition-colors"
              >
                Get Started
              </button>
              <div />
            </>
          )}
          {(step === 1 || step === 2) && (
            <>
              <button
                onClick={handleBack}
                className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleNext}
                className="px-6 py-2.5 text-sm font-semibold bg-accent text-white rounded-[10px] hover:bg-accent/90 transition-colors"
              >
                Next
              </button>
            </>
          )}
          {/* Step 3 has its own buttons inside StepAI */}
          {step === 3 && (
            <>
              <button
                onClick={handleBack}
                className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors"
              >
                Back
              </button>
              <div />
            </>
          )}
          {step === 4 && (
            <>
              <div />
              <button
                onClick={handleFinish}
                className="px-8 py-2.5 text-[15px] font-semibold bg-accent text-white rounded-xl hover:bg-accent/90 transition-colors"
              >
                Start using Saydo
              </button>
              <div />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
