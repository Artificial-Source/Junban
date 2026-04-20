import { useState, useCallback, useEffect, useRef } from "react";
import { themeManager } from "../themes/manager.js";
import { useGeneralSettings, type GeneralSettings } from "../context/SettingsContext.js";
import { approvePluginPermissions } from "../api/plugins.js";
import { DIRECT_PLUGIN_POLICIES } from "../../plugins/builtin/registry.js";
import { PRESETS, PRESET_BUILTIN_PLUGINS, TOTAL_STEPS } from "./onboarding/constants.js";
import { StepWelcome } from "./onboarding/StepWelcome.js";
import { StepTheme } from "./onboarding/StepTheme.js";
import { StepPreset } from "./onboarding/StepPreset.js";
import { StepAI } from "./onboarding/StepAI.js";
import { StepReady } from "./onboarding/StepReady.js";
import type { OnboardingModalProps, ThemeId, Preset } from "./onboarding/types.js";

export function OnboardingModal({
  open,
  onComplete,
  onRequestOpenSettings,
  mutationsBlocked = false,
  readOnly: readOnlyProp = false,
}: OnboardingModalProps) {
  const [step, setStep] = useState(0);
  const [selectedTheme, setSelectedTheme] = useState<ThemeId>("light");
  const [selectedAccent, setSelectedAccent] = useState("#3b82f6");
  const [selectedPreset, setSelectedPreset] = useState<Preset>("minimal");
  const [wantsAI, setWantsAI] = useState(false);

  const { updateSetting, readOnly: readOnlyFromContext } = useGeneralSettings();
  // Use the authoritative combined lock state: mutationsBlocked OR readOnly (from prop or context)
  const isLocked = mutationsBlocked || readOnlyProp || readOnlyFromContext;

  // Refs for focus management
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const getStartedButtonRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const finishButtonRef = useRef<HTMLButtonElement>(null);

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
      if (!isLocked) {
        themeManager.setTheme(themeId);
      }
    },
    [isLocked],
  );

  const handleAccentSelect = useCallback(
    (color: string) => {
      setSelectedAccent(color);
      if (!isLocked) {
        updateSetting("accent_color", color);
      }
    },
    [updateSetting, isLocked],
  );

  const handleFinish = useCallback(() => {
    void (async () => {
      if (isLocked) {
        // Skip all local writes when mutations are blocked or read-only
        onComplete();
        return;
      }

      const preset = PRESETS[selectedPreset];
      for (const [key, value] of Object.entries(preset)) {
        updateSetting(
          key as keyof GeneralSettings,
          value as GeneralSettings[keyof GeneralSettings],
        );
      }

      themeManager.setTheme(selectedTheme);
      updateSetting("accent_color", selectedAccent);

      const pluginIds = PRESET_BUILTIN_PLUGINS[selectedPreset];
      await Promise.allSettled(
        pluginIds.map((pluginId) =>
          approvePluginPermissions(pluginId, DIRECT_PLUGIN_POLICIES[pluginId].permissions),
        ),
      );

      onComplete();

      if (wantsAI) {
        onRequestOpenSettings?.("ai");
      }
    })();
  }, [
    selectedPreset,
    selectedTheme,
    selectedAccent,
    wantsAI,
    updateSetting,
    onComplete,
    onRequestOpenSettings,
    isLocked,
  ]);

  // Store previous focus and restore on close
  useEffect(() => {
    if (!open) return;

    // Store the previously focused element when modal opens
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus the primary action button when modal opens
    const timer = setTimeout(() => {
      if (step === 0 && getStartedButtonRef.current) {
        getStartedButtonRef.current.focus();
      } else if ((step === 1 || step === 2) && nextButtonRef.current) {
        nextButtonRef.current.focus();
      } else if (step === 4 && finishButtonRef.current) {
        finishButtonRef.current.focus();
      }
    }, 0);

    return () => {
      clearTimeout(timer);
      // Restore focus when modal closes
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === "function") {
        setTimeout(() => previousFocusRef.current?.focus(), 0);
      }
    };
  }, [open, step]);

  // Focus trap and Escape handling
  const handleModalKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Onboarding is mandatory, so Escape doesn't close it
      // But we could add a skip action in the future
      return;
    }

    if (e.key !== "Tab" || !modalRef.current) return;

    const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      // Shift + Tab
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      }
    } else {
      // Tab
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    }
  }, []);

  if (!open) return null;

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label="Junban onboarding"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onKeyDown={handleModalKeyDown}
    >
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
                ref={getStartedButtonRef}
                onClick={handleNext}
                className="px-8 py-2.5 text-sm font-semibold bg-accent text-white rounded-xl hover:bg-accent/90 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface"
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
                className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface rounded-lg"
              >
                Back
              </button>
              <button
                ref={nextButtonRef}
                onClick={handleNext}
                className="px-6 py-2.5 text-sm font-semibold bg-accent text-white rounded-[10px] hover:bg-accent/90 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface"
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
                className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface rounded-lg"
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
                ref={finishButtonRef}
                onClick={handleFinish}
                className="px-8 py-2.5 text-[15px] font-semibold bg-accent text-white rounded-xl hover:bg-accent/90 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface"
              >
                Start using Junban
              </button>
              <div />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
