import { FIXTURE_COPY, POMODORO_SETTINGS, fixtureStorePlugins, readFixture } from "./read-fixture";

export interface StorePluginInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  downloadUrl?: string;
  sha256?: string;
  tags: string[];
  minJunbanVersion: string;
  icon?: string;
  downloads?: number;
  longDescription?: string;
  permissions?: string[];
}

export interface SettingDefinitionInfo {
  id: string;
  name: string;
  type: "text" | "number" | "boolean" | "select";
  default: unknown;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  options?: string[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
  permissions: string[];
  settings: SettingDefinitionInfo[];
  builtin: boolean;
  icon?: string;
}

export interface PluginCommandInfo {
  id: string;
  name: string;
  hotkey?: string;
}

export interface StatusBarItemInfo {
  id: string;
  text: string;
  icon: string;
  onClick?: () => void;
}

export interface PanelInfo {
  id: string;
  pluginId: string;
  title: string;
  icon: string;
  content: string;
  contentType?: "text" | "react";
}

export interface ViewInfo {
  id: string;
  name: string;
  icon: string;
  slot: "navigation" | "tools" | "workspace";
  contentType: "text" | "structured" | "react";
  pluginId: string;
}

const pluginSettings: Record<string, Record<string, unknown>> = {
  pomodoro: {
    workMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    sessionsBeforeLongBreak: 4,
  },
  "sample-timer": {
    label: "Demo",
  },
};

async function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* intentional hang for loading fixture */
  });
}

export const api = {
  listPlugins: async (): Promise<PluginInfo[]> => [],
  getPluginStore: async (): Promise<{ plugins: StorePluginInfo[] }> => {
    const fixture = readFixture();
    if (fixture.storeMode === "loading") {
      return neverResolves();
    }
    if (fixture.storeMode === "error") {
      throw new Error(FIXTURE_COPY.registryError);
    }
    if (fixture.storeMode === "empty") {
      return { plugins: [] };
    }
    return { plugins: fixtureStorePlugins() };
  },
  getPluginSettings: async (pluginId: string) => {
    if (pluginId === "pomodoro") {
      return { ...pluginSettings.pomodoro };
    }
    return { ...(pluginSettings[pluginId] ?? {}) };
  },
  updatePluginSetting: async () => undefined,
  togglePlugin: async () => undefined,
  approvePluginPermissions: async () => undefined,
  revokePluginPermissions: async () => undefined,
  setCommunityPluginsEnabled: async () => undefined,
  installPlugin: async () => undefined,
  uninstallPlugin: async () => undefined,
  executePluginCommand: async () => undefined,
  getPluginViewContent: async () =>
    JSON.stringify({
      layout: "center",
      elements: [{ type: "text", value: "25:00", variant: "mono" }],
    }),
  getPluginSettingsDefinitions: async () => POMODORO_SETTINGS,
};

export const listPlugins = api.listPlugins;
export const getPluginStore = api.getPluginStore;
export const getPluginSettings = api.getPluginSettings;
export const updatePluginSetting = api.updatePluginSetting;
export const togglePlugin = api.togglePlugin;
export const approvePluginPermissions = api.approvePluginPermissions;
export const revokePluginPermissions = api.revokePluginPermissions;
export const setCommunityPluginsEnabled = api.setCommunityPluginsEnabled;
export const installPlugin = api.installPlugin;
export const uninstallPlugin = api.uninstallPlugin;
export const executePluginCommand = api.executePluginCommand;
export const getPluginViewContent = api.getPluginViewContent;
