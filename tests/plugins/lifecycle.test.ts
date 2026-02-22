import { describe, it, expect } from "vitest";
import { Plugin } from "../../src/plugins/lifecycle.js";
import type { PluginAPI, PluginSettingsAccessor } from "../../src/plugins/api.js";

class TestPlugin extends Plugin {
  loaded = false;
  unloaded = false;

  async onLoad(): Promise<void> {
    this.loaded = true;
  }

  async onUnload(): Promise<void> {
    this.unloaded = true;
  }
}

class ErrorPlugin extends Plugin {
  async onLoad(): Promise<void> {
    throw new Error("Load failed");
  }

  async onUnload(): Promise<void> {
    throw new Error("Unload failed");
  }
}

class TaskHookPlugin extends Plugin {
  createdTasks: any[] = [];
  completedTasks: any[] = [];

  async onLoad(): Promise<void> {}
  async onUnload(): Promise<void> {}

  onTaskCreate(task: any): void {
    this.createdTasks.push(task);
  }

  onTaskComplete(task: any): void {
    this.completedTasks.push(task);
  }
}

const mockAPI: PluginAPI = {} as any;
const mockSettings: PluginSettingsAccessor = {} as any;

describe("Plugin lifecycle", () => {
  it("onLoad sets loaded state", async () => {
    const plugin = new TestPlugin();
    plugin.app = mockAPI;
    plugin.settings = mockSettings;
    await plugin.onLoad();
    expect(plugin.loaded).toBe(true);
    expect(plugin.unloaded).toBe(false);
  });

  it("onUnload sets unloaded state", async () => {
    const plugin = new TestPlugin();
    plugin.app = mockAPI;
    plugin.settings = mockSettings;
    await plugin.onLoad();
    await plugin.onUnload();
    expect(plugin.unloaded).toBe(true);
  });

  it("plugin has app and settings properties", () => {
    const plugin = new TestPlugin();
    plugin.app = mockAPI;
    plugin.settings = mockSettings;
    expect(plugin.app).toBe(mockAPI);
    expect(plugin.settings).toBe(mockSettings);
  });

  it("onLoad error propagates", async () => {
    const plugin = new ErrorPlugin();
    plugin.app = mockAPI;
    plugin.settings = mockSettings;
    await expect(plugin.onLoad()).rejects.toThrow("Load failed");
  });

  it("onUnload error propagates", async () => {
    const plugin = new ErrorPlugin();
    plugin.app = mockAPI;
    plugin.settings = mockSettings;
    await expect(plugin.onUnload()).rejects.toThrow("Unload failed");
  });

  it("optional task hooks are undefined by default", () => {
    const plugin = new TestPlugin();
    expect(plugin.onTaskCreate).toBeUndefined();
    expect(plugin.onTaskComplete).toBeUndefined();
    expect(plugin.onTaskUpdate).toBeUndefined();
    expect(plugin.onTaskDelete).toBeUndefined();
  });

  it("task hooks can be implemented", () => {
    const plugin = new TaskHookPlugin();
    plugin.app = mockAPI;
    plugin.settings = mockSettings;

    const task = { id: "t1", title: "Test" };
    plugin.onTaskCreate!(task as any);
    expect(plugin.createdTasks).toEqual([task]);

    plugin.onTaskComplete!(task as any);
    expect(plugin.completedTasks).toEqual([task]);
  });

  it("lifecycle runs in correct order", async () => {
    const order: string[] = [];

    class OrderPlugin extends Plugin {
      async onLoad(): Promise<void> {
        order.push("load");
      }
      async onUnload(): Promise<void> {
        order.push("unload");
      }
    }

    const plugin = new OrderPlugin();
    plugin.app = mockAPI;
    plugin.settings = mockSettings;

    await plugin.onLoad();
    await plugin.onUnload();

    expect(order).toEqual(["load", "unload"]);
  });
});
