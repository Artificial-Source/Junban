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
    await manager.set("test-plugin", "workMinutes", 30);
    expect(manager.get<number>("test-plugin", "workMinutes", DEFINITIONS)).toBe(30);
  });

  it("stored value takes precedence over default", async () => {
    const manager = createManager();
    await manager.set("test-plugin", "greeting", "Hi there");
    expect(manager.get<string>("test-plugin", "greeting", DEFINITIONS)).toBe("Hi there");
  });

  it("throws for unknown setting with no default", () => {
    const manager = createManager();
    expect(() => manager.get("test-plugin", "nonexistent", DEFINITIONS)).toThrow(
      "Unknown setting: test-plugin/nonexistent",
    );
  });

  it("isolates settings between plugins", async () => {
    const manager = createManager();
    await manager.set("plugin-a", "workMinutes", 30);
    await manager.set("plugin-b", "workMinutes", 50);
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
    await manager.set("test-plugin", "workMinutes", 45);
    expect(manager.get<number>("test-plugin", "workMinutes", DEFINITIONS)).toBe(45);
  });
});
