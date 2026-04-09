import { describe, it, expect } from "vitest";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import type { SettingDefinition } from "../../src/plugins/types.js";
import { createTestServices } from "../integration/helpers.js";

const DEFINITIONS: SettingDefinition[] = [
  { id: "workMinutes", name: "Work", type: "number", default: 25 },
  { id: "greeting", name: "Greeting", type: "text", default: "Hello" },
  { id: "enabled", name: "Enabled", type: "boolean", default: true },
];

function createManager() {
  const { storage } = createTestServices();
  return new PluginSettingsManager(storage);
}

describe("PluginSettingsManager", () => {
  it("returns manifest default when no stored value", () => {
    const manager = createManager();
    expect(manager.get<number>("test-plugin", "workMinutes", DEFINITIONS)).toBe(25);
    expect(manager.get<string>("test-plugin", "greeting", DEFINITIONS)).toBe("Hello");
    expect(manager.get<boolean>("test-plugin", "enabled", DEFINITIONS)).toBe(true);
  });

  it("returns stored value when set", async () => {
    const manager = createManager();
    await manager.setSetting("test-plugin", "workMinutes", 30, DEFINITIONS);
    expect(manager.get<number>("test-plugin", "workMinutes", DEFINITIONS)).toBe(30);
  });

  it("stored value takes precedence over default", async () => {
    const manager = createManager();
    await manager.setSetting("test-plugin", "greeting", "Hi there", DEFINITIONS);
    expect(manager.get<string>("test-plugin", "greeting", DEFINITIONS)).toBe("Hi there");
  });

  it("throws for unknown setting with no default", () => {
    const manager = createManager();
    expect(() => manager.get("test-plugin", "nonexistent", DEFINITIONS)).toThrow(
      "Setting not found: test-plugin/nonexistent",
    );
  });

  it("isolates settings between plugins", async () => {
    const manager = createManager();
    await manager.setSetting("plugin-a", "workMinutes", 30, DEFINITIONS);
    await manager.setSetting("plugin-b", "workMinutes", 50, DEFINITIONS);
    expect(manager.get<number>("plugin-a", "workMinutes", DEFINITIONS)).toBe(30);
    expect(manager.get<number>("plugin-b", "workMinutes", DEFINITIONS)).toBe(50);
  });

  it("load initializes empty cache for new plugin", async () => {
    const manager = createManager();
    const settings = await manager.load("test-plugin");
    expect(settings).toEqual({});
  });

  it("set after load persists in cache", async () => {
    const manager = createManager();
    await manager.load("test-plugin");
    await manager.setSetting("test-plugin", "workMinutes", 45, DEFINITIONS);
    expect(manager.get<number>("test-plugin", "workMinutes", DEFINITIONS)).toBe(45);
  });

  it("rejects unknown setting keys", async () => {
    const manager = createManager();
    await expect(
      manager.setSetting("test-plugin", "not-in-manifest", "value", DEFINITIONS),
    ).rejects.toThrow('Invalid setting key "not-in-manifest" for plugin "test-plugin"');
  });

  it("rejects invalid setting types", async () => {
    const manager = createManager();
    await expect(
      manager.setSetting("test-plugin", "enabled", "true", DEFINITIONS),
    ).rejects.toThrow('Invalid value for setting "test-plugin/enabled"');
  });

  it("rejects numbers outside min/max constraints", async () => {
    const manager = createManager();
    const defs: SettingDefinition[] = [
      { id: "workMinutes", name: "Work", type: "number", default: 25, min: 1, max: 60 },
    ];

    await expect(manager.setSetting("test-plugin", "workMinutes", 0, defs)).rejects.toThrow(
      'Invalid value for setting "test-plugin/workMinutes": must be >= 1.',
    );
    await expect(manager.setSetting("test-plugin", "workMinutes", 61, defs)).rejects.toThrow(
      'Invalid value for setting "test-plugin/workMinutes": must be <= 60.',
    );
  });

  it("rejects select values not in options", async () => {
    const manager = createManager();
    const defs: SettingDefinition[] = [
      {
        id: "mode",
        name: "Mode",
        type: "select",
        default: "auto",
        options: ["auto", "manual"],
      },
    ];

    await expect(manager.setSetting("test-plugin", "mode", "invalid", defs)).rejects.toThrow(
      'Invalid value for setting "test-plugin/mode": must be one of auto, manual.',
    );
  });
});
