/**
 * Example plugin test — demonstrates how to test a Saydo plugin.
 *
 * This file serves as both a working test suite and documentation for plugin
 * authors. It covers:
 *
 * 1. Defining a plugin class (extends Plugin)
 * 2. Lifecycle (onLoad / onUnload)
 * 3. Command registration
 * 4. Settings read/write
 * 5. Task CRUD via the plugin API
 * 6. Event subscription
 * 7. Permission denial
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Plugin } from "../../src/plugins/lifecycle.js";
import type { Task } from "../../src/core/types.js";
import { createPluginTestEnv, createMockPluginAPI } from "./helpers.js";

// ── Example plugin definition ────────────────────────────────────────────────

class CounterPlugin extends Plugin {
  loadCount = 0;
  unloadCount = 0;
  receivedEvents: Array<{ event: string; data: unknown }> = [];

  async onLoad(): Promise<void> {
    this.loadCount++;

    // Register a command
    this.app.commands.register({
      id: "increment",
      name: "Counter: Increment",
      callback: () => {
        const current = this.settings.get<number>("count");
        this.settings.set("count", current + 1);
      },
    });

    // Subscribe to task creation events
    this.app.events.on("task:create", (task) => {
      this.receivedEvents.push({ event: "task:create", data: task });
    });
  }

  async onUnload(): Promise<void> {
    this.unloadCount++;
  }

  // Optional task lifecycle hook
  onTaskCreate(task: Task): void {
    this.receivedEvents.push({ event: "onTaskCreate-hook", data: task });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Example plugin (integration)", () => {
  let env: ReturnType<typeof createPluginTestEnv>;
  let plugin: CounterPlugin;

  beforeEach(async () => {
    env = createPluginTestEnv({
      permissions: [
        "task:read",
        "task:write",
        "project:read",
        "project:write",
        "tag:read",
        "tag:write",
        "commands",
        "settings",
        "storage",
      ],
      settings: [
        { id: "count", name: "Count", type: "number", default: 0 },
        { id: "label", name: "Label", type: "text", default: "My Counter" },
      ],
    });

    plugin = new CounterPlugin();
    plugin.app = env.api;
    plugin.settings = env.settings;
    await plugin.onLoad();
  });

  // ── 1. Lifecycle ─────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("calls onLoad exactly once", () => {
      expect(plugin.loadCount).toBe(1);
    });

    it("calls onUnload", async () => {
      await plugin.onUnload();
      expect(plugin.unloadCount).toBe(1);
    });

    it("can survive multiple load/unload cycles", async () => {
      await plugin.onUnload();
      // Clear the command registry between cycles (the loader does this automatically)
      env.commandRegistry.unregisterByPlugin(env.pluginId);
      await plugin.onLoad();
      await plugin.onUnload();
      expect(plugin.loadCount).toBe(2);
      expect(plugin.unloadCount).toBe(2);
    });
  });

  // ── 2. Command registration ──────────────────────────────────────────────

  describe("commands", () => {
    it("registers commands via the API", () => {
      const commands = env.commandRegistry.getAll();
      const counterCmd = commands.find((c) => c.id === "test-plugin:increment");
      expect(counterCmd).toBeDefined();
      expect(counterCmd!.name).toBe("Counter: Increment");
    });

    it("executes registered commands", () => {
      env.commandRegistry.execute("test-plugin:increment");
      expect(env.api.settings.get<number>("count")).toBe(1);
    });
  });

  // ── 3. Settings ──────────────────────────────────────────────────────────

  describe("settings", () => {
    it("reads manifest defaults", () => {
      expect(env.api.settings.get<number>("count")).toBe(0);
      expect(env.api.settings.get<string>("label")).toBe("My Counter");
    });

    it("persists overridden values", async () => {
      await env.api.settings.set("count", 42);
      expect(env.api.settings.get<number>("count")).toBe(42);
    });
  });

  // ── 4. Task CRUD ─────────────────────────────────────────────────────────

  describe("task CRUD", () => {
    it("creates and retrieves a task", async () => {
      const created = await env.api.tasks.create({
        title: "Test task from plugin",
        dueTime: false,
      });
      expect(created.id).toBeDefined();
      expect(created.title).toBe("Test task from plugin");

      const fetched = await env.api.tasks.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe("Test task from plugin");
    });

    it("updates a task", async () => {
      const task = await env.api.tasks.create({
        title: "Original",
        dueTime: false,
      });
      await env.api.tasks.update(task.id, { title: "Updated" });

      const fetched = await env.api.tasks.get(task.id);
      expect(fetched!.title).toBe("Updated");
    });

    it("completes and uncompletes a task", async () => {
      const task = await env.api.tasks.create({
        title: "Complete me",
        dueTime: false,
      });

      await env.api.tasks.complete(task.id);
      let fetched = await env.api.tasks.get(task.id);
      expect(fetched!.status).toBe("completed");

      await env.api.tasks.uncomplete(task.id);
      fetched = await env.api.tasks.get(task.id);
      expect(fetched!.status).toBe("pending");
    });

    it("lists tasks", async () => {
      await env.api.tasks.create({ title: "Task A", dueTime: false });
      await env.api.tasks.create({ title: "Task B", dueTime: false });

      const tasks = await env.api.tasks.list();
      expect(tasks.length).toBeGreaterThanOrEqual(2);
    });

    it("deletes a task", async () => {
      const task = await env.api.tasks.create({
        title: "Delete me",
        dueTime: false,
      });
      await env.api.tasks.delete(task.id);

      const tasks = await env.api.tasks.list();
      const found = tasks.find((t: Task) => t.id === task.id);
      expect(found).toBeUndefined();
    });
  });

  // ── 5. Event subscription ────────────────────────────────────────────────

  describe("events", () => {
    it("receives task:create events via the event bus", async () => {
      await env.api.tasks.create({ title: "Trigger event", dueTime: false });
      const createEvents = plugin.receivedEvents.filter(
        (e) => e.event === "task:create",
      );
      expect(createEvents.length).toBe(1);
      expect((createEvents[0].data as Task).title).toBe("Trigger event");
    });

    it("can unsubscribe from events", () => {
      const callback = () => {};
      env.api.events.on("task:delete", callback);
      expect(env.eventBus.listenerCount("task:delete")).toBe(1);

      env.api.events.off("task:delete", callback);
      expect(env.eventBus.listenerCount("task:delete")).toBe(0);
    });
  });

  // ── 6. Project and tag APIs ──────────────────────────────────────────────

  describe("projects and tags", () => {
    it("creates and lists projects", async () => {
      const project = await env.api.projects.create("Test Project");
      expect(project.id).toBeDefined();

      const projects = await env.api.projects.list();
      expect(projects.some((p) => p.id === project.id)).toBe(true);
    });

    it("creates and lists tags", async () => {
      const tag = await env.api.tags.create("urgent", "#ff0000");
      expect(tag.id).toBeDefined();

      const tags = await env.api.tags.list();
      expect(tags.some((t) => t.id === tag.id)).toBe(true);
    });
  });
});

// ── 7. Permission denial ───────────────────────────────────────────────────

describe("Permission denial", () => {
  it("throws when calling tasks.create without task:write", () => {
    const env = createPluginTestEnv({
      permissions: ["task:read"], // no task:write
    });

    expect(() => env.api.tasks.create({ title: "Nope", dueTime: false })).toThrow(
      'requires the "task:write" permission',
    );
  });

  it("throws when calling tasks.list without task:read", () => {
    const env = createPluginTestEnv({
      permissions: [], // no permissions at all
    });

    expect(() => env.api.tasks.list()).toThrow(
      'requires the "task:read" permission',
    );
  });

  it("throws when registering commands without commands permission", () => {
    const env = createPluginTestEnv({
      permissions: ["task:read"],
    });

    expect(() =>
      env.api.commands.register({
        id: "test",
        name: "Test",
        callback: () => {},
      }),
    ).toThrow('requires the "commands" permission');
  });

  it("throws when subscribing to events without task:read", () => {
    const env = createPluginTestEnv({
      permissions: [], // no task:read
    });

    expect(() => env.api.events.on("task:create", () => {})).toThrow(
      'requires the "task:read" permission',
    );
  });

  it("throws when calling projects.create without project:write", () => {
    const env = createPluginTestEnv({
      permissions: ["project:read"],
    });

    expect(() => env.api.projects.create("Nope")).toThrow(
      'requires the "project:write" permission',
    );
  });

  it("throws when calling ui.addView without ui:view", () => {
    const env = createPluginTestEnv({
      permissions: [],
    });

    expect(() =>
      env.api.ui.addView({ id: "v", name: "V", icon: "x" }),
    ).toThrow('requires the "ui:view" permission');
  });

  it("error message tells which permission to add", () => {
    const env = createPluginTestEnv({
      pluginId: "my-cool-plugin",
      permissions: [],
    });

    try {
      env.api.tags.create("test");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("my-cool-plugin");
      expect(msg).toContain("tag:write");
      expect(msg).toContain("manifest.json");
    }
  });
});

// ── Mock API usage example ─────────────────────────────────────────────────

describe("Example plugin with mock API (unit test)", () => {
  it("can test plugin behavior with mocked API", async () => {
    const { api, settings } = createMockPluginAPI();

    // Configure mock settings
    (settings.get as ReturnType<typeof import("vitest").vi.fn>).mockImplementation(
      (key: string) => {
        if (key === "count") return 5;
        return undefined;
      },
    );

    const plugin = new CounterPlugin();
    plugin.app = api;
    plugin.settings = settings;
    await plugin.onLoad();

    // Verify the plugin registered a command
    expect(api.commands.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "increment",
        name: "Counter: Increment",
      }),
    );

    // Verify event subscription
    expect(api.events.on).toHaveBeenCalledWith("task:create", expect.any(Function));

    await plugin.onUnload();
    expect(plugin.unloadCount).toBe(1);
  });
});
