import { useState } from "react";
import { themeManager } from "../../themes/manager.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";
import { DEFAULT_PROJECT_COLORS } from "../../../config/defaults.js";
import { SegmentedControl, ColorSwatchPicker, SettingRow, Toggle } from "./components.js";

export function AppearanceTab() {
  const { settings, loaded, updateSetting } = useGeneralSettings();
  const [currentTheme, setCurrentTheme] = useState(themeManager.getCurrent());

  const handleThemeChange = (themeId: string) => {
    themeManager.setTheme(themeId);
    setCurrentTheme(themeId);
  };

  if (!loaded) return null;

  return (
    <div className="space-y-8">
      {/* ── Theme ── */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-on-surface">Theme</h2>
        <div className="space-y-4 max-w-md">
          <SettingRow label="Color scheme" description="Choose light, dark, or match your system">
            <SegmentedControl
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "nord", label: "Nord" },
              ]}
              value={currentTheme}
              onChange={handleThemeChange}
            />
          </SettingRow>

          <div>
            <p className="text-sm text-on-surface mb-2">Accent color</p>
            <ColorSwatchPicker
              colors={DEFAULT_PROJECT_COLORS}
              value={settings.accent_color}
              onChange={(color) => updateSetting("accent_color", color)}
            />
          </div>
        </div>
      </section>

      {/* ── Layout ── */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-on-surface">Layout</h2>
        <div className="space-y-4 max-w-md">
          <SettingRow label="Density" description="Adjust UI spacing">
            <SegmentedControl
              options={[
                { value: "compact" as const, label: "Compact" },
                { value: "default" as const, label: "Default" },
                { value: "comfortable" as const, label: "Comfortable" },
              ]}
              value={settings.density}
              onChange={(v) => updateSetting("density", v)}
            />
          </SettingRow>

          <SettingRow label="Font size" description="Adjust base text size">
            <SegmentedControl
              options={[
                { value: "small" as const, label: "Small" },
                { value: "default" as const, label: "Default" },
                { value: "large" as const, label: "Large" },
              ]}
              value={settings.font_size}
              onChange={(v) => updateSetting("font_size", v)}
            />
          </SettingRow>
        </div>
      </section>

      {/* ── Accessibility ── */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-on-surface">Accessibility</h2>
        <div className="space-y-4 max-w-md">
          <SettingRow label="Reduce animations" description="Minimize motion for accessibility">
            <Toggle
              enabled={settings.reduce_animations === "true"}
              onToggle={() =>
                updateSetting(
                  "reduce_animations",
                  settings.reduce_animations === "true" ? "false" : "true",
                )
              }
            />
          </SettingRow>
        </div>
      </section>
    </div>
  );
}
