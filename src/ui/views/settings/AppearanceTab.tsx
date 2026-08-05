/**
 * Appearance — theme, accent swatches, density, font, reduced motion.
 * Runtime theme manager consumes only server-confirmed settings.
 */
import type { AppearanceSettingsDto } from "../../api/client";
import {
  ColorSwatchPicker,
  SettingRow,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsStatusBanner,
  SettingsToggle,
} from "./settingsComponents";
import { ACCENT_SWATCHES } from "./settingsHelpers";
import { useSettingsSave } from "./useSettingsSave";

export function AppearanceTab() {
  const { settings, settingsLoading, settingsError, refreshSettings, savePatch, savingKey, error } =
    useSettingsSave();

  if (settingsLoading && !settings) {
    return <p className="text-sm text-on-surface-muted">Loading settings…</p>;
  }
  if (!settings) {
    return (
      <SettingsStatusBanner kind="error">
        {settingsError ?? "Settings are unavailable."}{" "}
        <button type="button" className="underline" onClick={() => void refreshSettings()}>
          Retry
        </button>
      </SettingsStatusBanner>
    );
  }

  const appearance = settings.appearance;
  const busy = savingKey !== null;

  const patchAppearance = (partial: Partial<AppearanceSettingsDto>) =>
    void savePatch(`appearance:${Object.keys(partial).join(",")}`, {
      appearance: { ...appearance, ...partial },
    });

  return (
    <div className="space-y-8">
      {error && <SettingsStatusBanner kind="error">{error}</SettingsStatusBanner>}

      <SettingsSection title="Theme">
        <SettingRow
          label="Color scheme"
          description="Choose light, dark, Nord, or match your system"
          group
        >
          <SettingsSegmentedControl
            label="Color scheme"
            disabled={busy}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "nord", label: "Nord" },
            ]}
            value={appearance.theme}
            onChange={(value) => patchAppearance({ theme: value })}
          />
        </SettingRow>

        <ColorSwatchPicker
          label="Accent color"
          colors={ACCENT_SWATCHES}
          value={appearance.accent}
          disabled={busy}
          onChange={(color) => patchAppearance({ accent: color })}
        />
      </SettingsSection>

      <SettingsSection title="Layout">
        <SettingRow label="Density" description="Adjust UI spacing" group>
          <SettingsSegmentedControl
            label="Density"
            disabled={busy}
            options={[
              { value: "compact", label: "Compact" },
              { value: "default", label: "Default" },
              { value: "comfortable", label: "Comfortable" },
            ]}
            value={appearance.density}
            onChange={(value) => patchAppearance({ density: value })}
          />
        </SettingRow>

        <SettingRow label="Font size" description="Adjust base text size" group>
          <SettingsSegmentedControl
            label="Font size"
            disabled={busy}
            options={[
              { value: "small", label: "Small" },
              { value: "medium", label: "Default" },
              { value: "large", label: "Large" },
            ]}
            value={appearance.font_size}
            onChange={(value) => patchAppearance({ font_size: value })}
          />
        </SettingRow>

        <SettingRow label="Font family" description="Choose the typeface for the app" group>
          <SettingsSegmentedControl
            label="Font family"
            disabled={busy}
            options={[
              { value: "outfit", label: "Outfit" },
              { value: "inter", label: "Inter" },
              { value: "system", label: "System" },
            ]}
            value={appearance.font_family}
            onChange={(value) => patchAppearance({ font_family: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Accessibility">
        <SettingRow label="Reduce animations" description="Minimize motion for accessibility">
          <SettingsToggle
            label="Reduce animations"
            enabled={appearance.reduced_motion}
            disabled={busy}
            onToggle={() => patchAppearance({ reduced_motion: !appearance.reduced_motion })}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
