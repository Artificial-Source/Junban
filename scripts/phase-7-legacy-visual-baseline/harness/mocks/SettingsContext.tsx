import { createContext, useContext, useMemo, type ReactNode } from "react";
import { readFixture } from "./read-fixture";

/** Minimal GeneralSettings surface consumed by PluginsTab. */
export interface GeneralSettings {
  community_plugins_enabled: "true" | "false";
  accent_color: string;
  density: "compact" | "default" | "comfortable";
  font_family: "outfit" | "inter" | "system";
  reduce_animations: "true" | "false";
}

export const DEFAULT_SETTINGS: GeneralSettings = {
  community_plugins_enabled: "false",
  accent_color: "#3b82f6",
  density: "comfortable",
  font_family: "system",
  reduce_animations: "true",
};

interface GeneralSettingsContextValue {
  settings: GeneralSettings;
  loaded: boolean;
  updateSetting: (key: string, value: string) => Promise<void>;
  refreshSettings: () => Promise<void>;
}

const GeneralSettingsContext = createContext<GeneralSettingsContextValue | null>(null);

async function asyncNoop() {}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const value = useMemo<GeneralSettingsContextValue>(() => {
    const fixture = readFixture();
    return {
      settings: {
        ...DEFAULT_SETTINGS,
        community_plugins_enabled: fixture.communityPluginsEnabled ? "true" : "false",
      },
      loaded: true,
      updateSetting: asyncNoop,
      refreshSettings: asyncNoop,
    };
  }, []);

  return (
    <GeneralSettingsContext.Provider value={value}>{children}</GeneralSettingsContext.Provider>
  );
}

export function useGeneralSettings(): GeneralSettingsContextValue {
  const ctx = useContext(GeneralSettingsContext);
  if (!ctx) {
    throw new Error("useGeneralSettings requires SettingsProvider");
  }
  return ctx;
}

// Legacy module also exports Theme/other hooks from this file in some paths.
// Provide no-op stubs so accidental imports do not crash the harness.
export function useSettings() {
  return useGeneralSettings();
}
