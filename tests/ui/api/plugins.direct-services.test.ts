import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetServices = vi.fn();

vi.mock("../../../src/ui/api/helpers.js", () => ({
  useDirectServices: () => true,
  BASE: "/api",
  handleResponse: async (res: Response) => res.json(),
  handleVoidResponse: async () => {},
}));

vi.mock("../../../src/ui/api/direct-services.js", () => ({
  getServices: () => mockGetServices(),
}));

import {
  DIRECT_PLUGIN_POLICIES,
  approvePluginPermissions,
  getPluginSettings,
  listPlugins,
  revokePluginPermissions,
  togglePlugin,
  updatePluginSetting,
} from "../../../src/ui/api/plugins.js";

describe("ui/api/plugins direct-services settings path", () => {
  const mockSettingsManager = {
    getAll: vi.fn(),
    setSetting: vi.fn(),
  };
  const mockSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServices.mockResolvedValue({
      builtinPlugins: [
        {
          id: "pomodoro",
          name: "Pomodoro Timer",
          version: "1.0.0",
          author: "ASF",
          description: "Focus timer with configurable work/break intervals.",
          enabled: true,
          permissions: DIRECT_PLUGIN_POLICIES.pomodoro.permissions,
          settings: DIRECT_PLUGIN_POLICIES.pomodoro.settings,
          builtin: true,
          icon: "🍅",
        },
      ],
      settingsManager: mockSettingsManager,
      save: mockSave,
    });
  });

  it("listPlugins returns initialized built-ins in direct-services mode", async () => {
    const plugins = await listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: "pomodoro",
      builtin: true,
      enabled: true,
      icon: "🍅",
    });
  });

  it("getPluginSettings enforces manifest defaults in direct-services mode", async () => {
    mockSettingsManager.getAll.mockReturnValue({ workMinutes: 30 });

    const settings = await getPluginSettings("pomodoro");

    expect(settings).toEqual({
      workMinutes: 30,
      breakMinutes: 5,
      longBreakMinutes: 15,
      sessionsBeforeLongBreak: 4,
    });
  });

  it("updatePluginSetting validates against manifest definitions in direct-services mode", async () => {
    await updatePluginSetting("pomodoro", "workMinutes", 45);

    expect(mockSettingsManager.setSetting).toHaveBeenCalledWith(
      "pomodoro",
      "workMinutes",
      45,
      expect.any(Array),
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("throws for unknown plugin IDs in direct-services mode", async () => {
    await expect(getPluginSettings("unknown-plugin")).rejects.toThrow("Plugin not found");
  });

  it("enforces settings permission in direct-services mode", async () => {
    DIRECT_PLUGIN_POLICIES["no-settings-permission"] = {
      permissions: ["commands"],
      settings: [],
    };

    try {
      await expect(getPluginSettings("no-settings-permission")).rejects.toThrow(
        'Plugin "no-settings-permission" does not have the "settings" permission.',
      );
    } finally {
      delete DIRECT_PLUGIN_POLICIES["no-settings-permission"];
    }
  });

  it("approve/revoke/toggle fail explicitly in direct-services mode", async () => {
    await expect(approvePluginPermissions("pomodoro", ["commands"])).rejects.toThrow(
      "Plugin permission approval is not available in direct-services mode",
    );
    await expect(revokePluginPermissions("pomodoro")).rejects.toThrow(
      "Plugin permission revocation is not available in direct-services mode",
    );
    await expect(togglePlugin("pomodoro")).rejects.toThrow(
      "Plugin toggle is not available in direct-services mode",
    );
  });
});
