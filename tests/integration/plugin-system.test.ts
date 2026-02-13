import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestServices } from "./helpers.js";
import { PluginLoader } from "../../src/plugins/loader.js";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import { CommandRegistry } from "../../src/plugins/command-registry.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";
import { createPluginAPI } from "../../src/plugins/api.js";
import type { Permission } from "../../src/plugins/types.js";

function createTempPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "docket-plugins-"));
}

function writePlugin(
  pluginDir: string,
  name: string,
  manifest: Record<string, unknown>,
  code: string,
) {
  const dir = path.join(pluginDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "index.mjs"), code);
}

const validManifest = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "1.0.0",
  author: "Test",
  description: "A test plugin",
  main: "index.mjs",
  minDocketVersion: "0.1.0",
  permissions: ["task:read", "commands", "ui:status"],
};

const pluginCode = `
export default class TestPlugin {
  async onLoad() {
    this.app.events.on("task:create", (task) => {
      console.log("task created:", task.title);
    });
  }
  async onUnload() {}
}
`;

describe("Plugin System Integration", () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = createTempPluginDir();
  });

  afterEach(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  describe("EventBus + TaskService", () => {
    it("should emit task:create when a task is created", async () => {
      const { taskService, eventBus } = createTestServices();
      const callback = vi.fn();
      eventBus.on("task:create", callback);

      await taskService.create({ title: "Test task" });

      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].title).toBe("Test task");
    });

    it("should emit task:complete when a task is completed", async () => {
      const { taskService, eventBus } = createTestServices();
      const callback = vi.fn();
      eventBus.on("task:complete", callback);

      const task = await taskService.create({ title: "Complete me" });
      await taskService.complete(task.id);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].status).toBe("completed");
    });

    it("should emit task:update when a task is updated", async () => {
      const { taskService, eventBus } = createTestServices();
      const callback = vi.fn();
      eventBus.on("task:update", callback);

      const task = await taskService.create({ title: "Update me" });
      await taskService.update(task.id, { title: "Updated" });

      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].task.title).toBe("Updated");
    });

    it("should emit task:delete when a task is deleted", async () => {
      const { taskService, eventBus } = createTestServices();
      const callback = vi.fn();
      eventBus.on("task:delete", callback);

      const task = await taskService.create({ title: "Delete me" });
      await taskService.delete(task.id);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].title).toBe("Delete me");
    });
  });

  describe("PluginLoader - discover", () => {
    it("should discover a valid plugin", async () => {
      const { taskService, eventBus, storage } = createTestServices();
      writePlugin(pluginDir, "test-plugin", validManifest, pluginCode);

      const loader = new PluginLoader(pluginDir, {
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        queries: storage,
      });

      const discovered = await loader.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].manifest.id).toBe("test-plugin");
      expect(discovered[0].enabled).toBe(false);
    });

    it("should skip directories without manifest.json", async () => {
      const { taskService, eventBus, storage } = createTestServices();
      fs.mkdirSync(path.join(pluginDir, "no-manifest"), { recursive: true });

      const loader = new PluginLoader(pluginDir, {
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        queries: storage,
      });

      const discovered = await loader.discover();
      expect(discovered).toHaveLength(0);
    });

    it("should reject invalid manifests", async () => {
      const { taskService, eventBus, storage } = createTestServices();
      const invalid = { id: "INVALID ID!", name: "Bad" }; // Missing required fields
      writePlugin(pluginDir, "bad-plugin", invalid, "");

      const loader = new PluginLoader(pluginDir, {
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        queries: storage,
      });

      const discovered = await loader.discover();
      expect(discovered).toHaveLength(0);
    });

    it("should handle non-existent plugin directory", async () => {
      const { taskService, eventBus, storage } = createTestServices();
      const loader = new PluginLoader("/nonexistent/path", {
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
      });

      const discovered = await loader.discover();
      expect(discovered).toHaveLength(0);
    });
  });

  describe("PluginLoader - load/unload lifecycle", () => {
    it("should load a plugin and call onLoad", async () => {
      const { taskService, eventBus, storage } = createTestServices();
      const loadCode = `
        export default class TestPlugin {
          async onLoad() { globalThis.__testPluginLoaded = true; }
          async onUnload() { globalThis.__testPluginLoaded = false; }
        }
      `;
      writePlugin(pluginDir, "test-plugin", validManifest, loadCode);

      const loader = new PluginLoader(pluginDir, {
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        queries: storage,
      });

      await loader.discover();
      // Pre-approve permissions so the plugin loads
      storage.setPluginPermissions("test-plugin", ["task:read", "commands", "ui:status"]);
      await loader.load("test-plugin");

      const plugin = loader.get("test-plugin");
      expect(plugin?.enabled).toBe(true);
      expect((globalThis as Record<string, unknown>).__testPluginLoaded).toBe(true);

      // Cleanup
      await loader.unload("test-plugin");
      expect(plugin?.enabled).toBe(false);
      expect((globalThis as Record<string, unknown>).__testPluginLoaded).toBe(false);
    });

    it("should clean up commands and UI on unload", async () => {
      const { taskService, eventBus, storage } = createTestServices();
      const commandRegistry = new CommandRegistry();
      const uiRegistry = new UIRegistry();

      const code = `
        export default class TestPlugin {
          async onLoad() {
            this.app.commands?.register({
              id: "test:cmd",
              name: "Test Command",
              callback: () => {},
            });
            this.app.ui.addStatusBarItem?.({
              id: "test-status",
              text: "test",
              icon: "circle",
            });
          }
          async onUnload() {}
        }
      `;
      writePlugin(pluginDir, "test-plugin", validManifest, code);

      const loader = new PluginLoader(pluginDir, {
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry,
        uiRegistry,
        queries: storage,
      });

      await loader.discover();
      storage.setPluginPermissions("test-plugin", ["task:read", "commands", "ui:status"]);
      await loader.load("test-plugin");

      expect(commandRegistry.getAll()).toHaveLength(1);
      expect(uiRegistry.getStatusBarItems()).toHaveLength(1);

      await loader.unload("test-plugin");

      expect(commandRegistry.getAll()).toHaveLength(0);
      expect(uiRegistry.getStatusBarItems()).toHaveLength(0);
    });
  });

  describe("Plugin API - permission gating", () => {
    it("should allow access to permitted APIs", () => {
      const { taskService, eventBus, storage } = createTestServices();
      const api = createPluginAPI({
        pluginId: "test",
        permissions: ["task:read", "commands", "storage"] as Permission[],
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        settingDefinitions: [],
      });

      expect(api.tasks.list).toBeDefined();
      expect(api.commands).toBeDefined();
      expect(api.storage).toBeDefined();
    });

    it("should deny access to unpermitted APIs", () => {
      const { taskService, eventBus, storage } = createTestServices();
      const api = createPluginAPI({
        pluginId: "test",
        permissions: [] as Permission[],
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        settingDefinitions: [],
      });

      expect(api.tasks.list).toBeUndefined();
      expect(api.tasks.create).toBeUndefined();
      expect(api.commands).toBeUndefined();
      expect(api.storage).toBeUndefined();
      expect(api.ui.addSidebarPanel).toBeUndefined();
      expect(api.ui.addView).toBeUndefined();
      expect(api.ui.addStatusBarItem).toBeUndefined();
    });

    it("should throw when accessing events without task:read permission", () => {
      const { taskService, eventBus, storage } = createTestServices();
      const api = createPluginAPI({
        pluginId: "restricted",
        permissions: [] as Permission[],
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        settingDefinitions: [],
      });

      expect(() => api.events.on("task:create", () => {})).toThrow(/lacks "task:read" permission/);
    });
  });

  describe("PluginSettingsManager - DB persistence", () => {
    it("should save and load settings via database", async () => {
      const { storage } = createTestServices();
      const manager = new PluginSettingsManager(storage);

      await manager.set("my-plugin", "color", "blue");
      await manager.set("my-plugin", "count", 42);

      // Create a new manager to simulate fresh load from DB
      const manager2 = new PluginSettingsManager(storage);
      const loaded = await manager2.load("my-plugin");

      expect(loaded.color).toBe("blue");
      expect(loaded.count).toBe(42);
    });

    it("should return empty settings for unknown plugin", async () => {
      const { storage } = createTestServices();
      const manager = new PluginSettingsManager(storage);
      const loaded = await manager.load("nonexistent");
      expect(loaded).toEqual({});
    });

    it("should fall back to manifest defaults for get()", () => {
      const { storage } = createTestServices();
      const manager = new PluginSettingsManager(storage);

      const defs = [{ id: "color", name: "Color", type: "text" as const, default: "red" }];

      expect(manager.get("test", "color", defs)).toBe("red");
    });

    it("should delete settings", async () => {
      const { storage } = createTestServices();
      const manager = new PluginSettingsManager(storage);

      await manager.set("my-plugin", "key1", "value1");
      await manager.set("my-plugin", "key2", "value2");

      await manager.delete("my-plugin", "key1");

      expect(manager.keys("my-plugin")).toEqual(["key2"]);
    });
  });

  describe("CommandRegistry", () => {
    it("should register and execute commands", () => {
      const registry = new CommandRegistry();
      const callback = vi.fn();

      registry.register({
        id: "plugin:cmd",
        name: "Test",
        pluginId: "plugin",
        callback,
      });

      registry.execute("plugin:cmd");
      expect(callback).toHaveBeenCalledOnce();
    });

    it("should throw on duplicate registration", () => {
      const registry = new CommandRegistry();
      registry.register({
        id: "cmd1",
        name: "Test",
        pluginId: "p",
        callback: () => {},
      });

      expect(() =>
        registry.register({
          id: "cmd1",
          name: "Test 2",
          pluginId: "p",
          callback: () => {},
        }),
      ).toThrow(/already registered/);
    });

    it("should unregister all commands for a plugin", () => {
      const registry = new CommandRegistry();
      registry.register({ id: "p:a", name: "A", pluginId: "p", callback: () => {} });
      registry.register({ id: "p:b", name: "B", pluginId: "p", callback: () => {} });
      registry.register({ id: "q:c", name: "C", pluginId: "q", callback: () => {} });

      registry.unregisterByPlugin("p");

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getAll()[0].pluginId).toBe("q");
    });
  });

  describe("UIRegistry", () => {
    it("should register and return status bar items", () => {
      const registry = new UIRegistry();
      const handle = registry.addStatusBarItem({
        id: "status-1",
        pluginId: "test",
        text: "Hello",
        icon: "circle",
      });

      expect(registry.getStatusBarItems()).toHaveLength(1);
      expect(registry.getStatusBarItems()[0].text).toBe("Hello");

      handle.update({ text: "Updated" });
      expect(registry.getStatusBarItems()[0].text).toBe("Updated");
    });

    it("should remove all registrations for a plugin", () => {
      const registry = new UIRegistry();
      registry.addPanel({ id: "p1", pluginId: "test", title: "Panel", icon: "x", component: null });
      registry.addView({ id: "v1", pluginId: "test", name: "View", icon: "x", component: null });
      registry.addStatusBarItem({ id: "s1", pluginId: "test", text: "Status", icon: "x" });

      registry.removeByPlugin("test");

      expect(registry.getPanels()).toHaveLength(0);
      expect(registry.getViews()).toHaveLength(0);
      expect(registry.getStatusBarItems()).toHaveLength(0);
    });

    it("should register panel with getContent and return content", () => {
      const registry = new UIRegistry();
      registry.addPanel({
        id: "p1",
        pluginId: "test",
        title: "Panel",
        icon: "x",
        component: null,
        getContent: () => "Hello from panel",
      });

      expect(registry.getPanels()).toHaveLength(1);
      expect(registry.getPanelContent("p1")).toBe("Hello from panel");
    });

    it("should register view with getContent and return content", () => {
      const registry = new UIRegistry();
      registry.addView({
        id: "v1",
        pluginId: "test",
        name: "View",
        icon: "x",
        component: null,
        getContent: () => "Hello from view",
      });

      expect(registry.getViews()).toHaveLength(1);
      expect(registry.getViewContent("v1")).toBe("Hello from view");
    });

    it("should return undefined for panel/view content without getContent", () => {
      const registry = new UIRegistry();
      registry.addPanel({ id: "p1", pluginId: "test", title: "Panel", icon: "x", component: null });
      registry.addView({ id: "v1", pluginId: "test", name: "View", icon: "x", component: null });

      expect(registry.getPanelContent("p1")).toBeUndefined();
      expect(registry.getViewContent("v1")).toBeUndefined();
    });
  });

  describe("Command palette integration", () => {
    it("should list plugin commands from command registry", () => {
      const registry = new CommandRegistry();

      registry.register({
        id: "plugin1:cmd1",
        name: "Plugin One: Do Thing",
        pluginId: "plugin1",
        callback: () => {},
      });
      registry.register({
        id: "plugin2:cmd2",
        name: "Plugin Two: Do Other",
        pluginId: "plugin2",
        callback: () => {},
        hotkey: "Ctrl+Shift+P",
      });

      const commands = registry.getAll();
      expect(commands).toHaveLength(2);
      expect(commands[0].name).toBe("Plugin One: Do Thing");
      expect(commands[1].hotkey).toBe("Ctrl+Shift+P");
    });
  });

  describe("Full lifecycle", () => {
    it("should discover → load → receive events → unload", async () => {
      const { taskService, eventBus, storage } = createTestServices();

      const code = `
        let count = 0;
        export default class CountPlugin {
          async onLoad() {
            this.app.events.on("task:create", () => {
              count++;
              globalThis.__pluginEventCount = count;
            });
          }
          async onUnload() {
            globalThis.__pluginEventCount = -1;
          }
        }
      `;
      writePlugin(pluginDir, "test-plugin", validManifest, code);

      const loader = new PluginLoader(pluginDir, {
        taskService,
        eventBus,
        settingsManager: new PluginSettingsManager(storage),
        commandRegistry: new CommandRegistry(),
        uiRegistry: new UIRegistry(),
        queries: storage,
      });

      // Pre-approve and discover + load
      storage.setPluginPermissions("test-plugin", ["task:read", "commands", "ui:status"]);
      await loader.loadAll();
      expect(loader.getAll().filter((p) => p.enabled)).toHaveLength(1);

      // Create tasks — plugin should receive events
      await taskService.create({ title: "Task 1" });
      await taskService.create({ title: "Task 2" });
      expect((globalThis as Record<string, unknown>).__pluginEventCount).toBe(2);

      // Unload
      await loader.unloadAll();
      expect((globalThis as Record<string, unknown>).__pluginEventCount).toBe(-1);
      expect(loader.getAll().filter((p) => p.enabled)).toHaveLength(0);
    });
  });
});
