import { describe, it, expect, vi } from "vitest";
import { Plugin } from "../../src/plugins/lifecycle.js";
import { EventBus } from "../../src/core/event-bus.js";
import type { Task } from "../../src/core/types.js";
import type { PluginAPI, PluginSettingsAccessor } from "../../src/plugins/api.js";
import { PluginLoader } from "../../src/plugins/loader.js";
import type { PluginServices } from "../../src/plugins/loader.js";

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

const mockTask: Task = {
  id: "task-1",
  title: "Test task",
  description: null,
  status: "pending",
  priority: null,
  dueDate: null,
  dueTime: false,
  completedAt: null,
  projectId: null,
  recurrence: null,
  parentId: null,
  remindAt: null,
  estimatedMinutes: null,
  actualMinutes: null,
  deadline: null,
  isSomeday: false,
  sectionId: null,
  dreadLevel: null,
  tags: [],
  sortOrder: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

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

// ── Loader integration tests ─────────────────────────────────────────────────

/**
 * Helper to create a PluginLoader with a mock module loader that returns
 * the given plugin class as the default export.
 */
function createTestLoader(
  PluginClass: new () => Plugin,
  overrides?: Partial<PluginServices>,
) {
  const eventBus = new EventBus();
  const services: PluginServices = {
    taskService: {} as any,
    projectService: {} as any,
    tagService: {} as any,
    eventBus,
    settingsManager: { load: vi.fn() } as any,
    commandRegistry: {
      unregisterByPlugin: vi.fn(),
    } as any,
    uiRegistry: { removeByPlugin: vi.fn() } as any,
    queries: {
      getAppSetting: vi.fn().mockReturnValue({ value: "true" }),
      getPluginPermissions: vi.fn().mockReturnValue([]),
      setPluginPermissions: vi.fn(),
      deletePluginPermissions: vi.fn(),
    } as any,
    ...overrides,
  };

  const loader = new PluginLoader("/tmp/test-plugins", services);

  // Inject a fake plugin into the internal map via discoverOne-like approach:
  // We use setModuleLoader so that `load()` gets our class.
  loader.setModuleLoader(async () => ({ default: PluginClass }));

  // Manually insert a plugin entry so load() finds it
  const pluginId = "test-plugin";
  const fakeManifest = {
    id: pluginId,
    name: "Test Plugin",
    version: "1.0.0",
    author: "test",
    description: "test",
    main: "index.js",
    permissions: ["task:read"],
  };
  // Access the private map — acceptable in tests
  (loader as any).plugins.set(pluginId, {
    manifest: fakeManifest,
    path: "/tmp/test-plugins/test-plugin",
    enabled: false,
    builtin: true,
  });

  return { loader, eventBus, services, pluginId };
}

describe("PluginLoader — task hook wiring", () => {
  it("fires onTaskCreate when EventBus emits task:create", async () => {
    const createSpy = vi.fn();

    class HookPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskCreate(task: Task): void {
        createSpy(task);
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(HookPlugin);
    await loader.load(pluginId);

    eventBus.emit("task:create", mockTask);
    expect(createSpy).toHaveBeenCalledWith(mockTask);
  });

  it("fires onTaskComplete when EventBus emits task:complete", async () => {
    const completeSpy = vi.fn();

    class HookPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskComplete(task: Task): void {
        completeSpy(task);
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(HookPlugin);
    await loader.load(pluginId);

    eventBus.emit("task:complete", mockTask);
    expect(completeSpy).toHaveBeenCalledWith(mockTask);
  });

  it("fires onTaskUpdate with task and changes", async () => {
    const updateSpy = vi.fn();

    class HookPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskUpdate(task: Task, changes: Partial<Task>): void {
        updateSpy(task, changes);
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(HookPlugin);
    await loader.load(pluginId);

    const changes = { title: "Updated" };
    eventBus.emit("task:update", { task: mockTask, changes });
    expect(updateSpy).toHaveBeenCalledWith(mockTask, changes);
  });

  it("fires onTaskDelete when EventBus emits task:delete", async () => {
    const deleteSpy = vi.fn();

    class HookPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskDelete(task: Task): void {
        deleteSpy(task);
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(HookPlugin);
    await loader.load(pluginId);

    eventBus.emit("task:delete", mockTask);
    expect(deleteSpy).toHaveBeenCalledWith(mockTask);
  });

  it("does not register listeners for hooks that are not implemented", async () => {
    // TestPlugin has no task hooks
    const { loader, eventBus, pluginId } = createTestLoader(TestPlugin);
    await loader.load(pluginId);

    expect(eventBus.listenerCount("task:create")).toBe(0);
    expect(eventBus.listenerCount("task:complete")).toBe(0);
    expect(eventBus.listenerCount("task:update")).toBe(0);
    expect(eventBus.listenerCount("task:delete")).toBe(0);
  });

  it("does not wire lifecycle task hooks without task:read permission", async () => {
    const createSpy = vi.fn();

    class HookPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskCreate(task: Task): void {
        createSpy(task);
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(HookPlugin);
    (loader as any).plugins.get(pluginId).manifest.permissions = ["task:write"];

    await loader.load(pluginId);

    expect(eventBus.listenerCount("task:create")).toBe(0);
    eventBus.emit("task:create", mockTask);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("PluginLoader — crash isolation", () => {
  it("a crashing onTaskCreate hook does not propagate", async () => {
    class CrashPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskCreate(): void {
        throw new Error("Hook crash!");
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(CrashPlugin);
    await loader.load(pluginId);

    // Should not throw
    expect(() => eventBus.emit("task:create", mockTask)).not.toThrow();
  });

  it("a crashing hook does not prevent other listeners from firing", async () => {
    const spy = vi.fn();

    class CrashPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskCreate(): void {
        throw new Error("Hook crash!");
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(CrashPlugin);
    await loader.load(pluginId);

    // Add another listener after the plugin's
    eventBus.on("task:create", spy);
    eventBus.emit("task:create", mockTask);

    expect(spy).toHaveBeenCalledWith(mockTask);
  });
});

describe("PluginLoader — lifecycle timeouts", () => {
  it("onLoad times out if it never resolves", async () => {
    class HangPlugin extends Plugin {
      async onLoad(): Promise<void> {
        // Never resolves
        await new Promise(() => {});
      }
      async onUnload(): Promise<void> {}
    }

    const { loader, pluginId } = createTestLoader(HangPlugin);

    // Override the timeout to be short for testing
    const origTimeout = (PluginLoader as any).lifecycleTimeout;
    (PluginLoader as any).lifecycleTimeout = (id: string, _ms: number) =>
      origTimeout(id, 100);

    try {
      await expect(loader.load(pluginId)).rejects.toThrow(/timed out/);
    } finally {
      (PluginLoader as any).lifecycleTimeout = origTimeout;
    }
  });

  it("onUnload times out if it never resolves", async () => {
    class HangUnloadPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {
        await new Promise(() => {});
      }
    }

    const { loader, pluginId } = createTestLoader(HangUnloadPlugin);
    await loader.load(pluginId);

    const origTimeout = (PluginLoader as any).lifecycleTimeout;
    (PluginLoader as any).lifecycleTimeout = (id: string, _ms: number) =>
      origTimeout(id, 100);

    try {
      // unload catches the error internally, so it should not throw
      await loader.unload(pluginId);
      // Verify the plugin was still cleaned up
      const plugin = loader.get(pluginId);
      expect(plugin?.enabled).toBe(false);
      expect(plugin?.instance).toBeUndefined();
    } finally {
      (PluginLoader as any).lifecycleTimeout = origTimeout;
    }
  });
});

describe("PluginLoader — hook cleanup on unload", () => {
  it("removes EventBus listeners when plugin is unloaded", async () => {
    const spy = vi.fn();

    class HookPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
      onTaskCreate(task: Task): void {
        spy(task);
      }
    }

    const { loader, eventBus, pluginId } = createTestLoader(HookPlugin);
    await loader.load(pluginId);

    expect(eventBus.listenerCount("task:create")).toBe(1);

    await loader.unload(pluginId);

    expect(eventBus.listenerCount("task:create")).toBe(0);

    // Emitting after unload should not call the hook
    eventBus.emit("task:create", mockTask);
    expect(spy).not.toHaveBeenCalled();
  });

  it("removes app.events.on listeners registered by plugin API on unload", async () => {
    class EventApiPlugin extends Plugin {
      private onCreate = () => {};

      async onLoad(): Promise<void> {
        this.app.events.on("task:create", this.onCreate);
      }

      async onUnload(): Promise<void> {}
    }

    const { loader, eventBus, pluginId, services } = createTestLoader(EventApiPlugin);
    (loader as any).plugins.get(pluginId).manifest.permissions = ["task:read"];
    (services.queries.getPluginPermissions as any).mockReturnValue(["task:read"]);

    await loader.load(pluginId);
    expect(eventBus.listenerCount("task:create")).toBe(1);

    await loader.unload(pluginId);
    expect(eventBus.listenerCount("task:create")).toBe(0);
  });

  it("removes app.events.on listeners when onLoad fails", async () => {
    class FailingEventApiPlugin extends Plugin {
      async onLoad(): Promise<void> {
        this.app.events.on("task:create", () => {});
        throw new Error("boom");
      }

      async onUnload(): Promise<void> {}
    }

    const { loader, eventBus, pluginId, services } = createTestLoader(
      FailingEventApiPlugin,
    );
    (loader as any).plugins.get(pluginId).manifest.permissions = ["task:read"];
    (services.queries.getPluginPermissions as any).mockReturnValue(["task:read"]);

    await expect(loader.load(pluginId)).rejects.toThrow("boom");
    expect(eventBus.listenerCount("task:create")).toBe(0);
  });

  it("unregisters plugin tools on normal unload", async () => {
    class BasicPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
    }

    const unregisterBySource = vi.fn();
    const { loader, pluginId } = createTestLoader(BasicPlugin, {
      toolRegistry: {
        unregisterBySource,
      } as any,
    });

    await loader.load(pluginId);
    await loader.unload(pluginId);

    expect(unregisterBySource).toHaveBeenCalledWith(pluginId);
  });
});

describe("PluginLoader — lifecycle timeout cleanup", () => {
  it("cancels load timeout when onLoad resolves", async () => {
    class FastPlugin extends Plugin {
      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
    }

    const cancel = vi.fn();
    const origTimeout = (PluginLoader as any).lifecycleTimeout;
    (PluginLoader as any).lifecycleTimeout = (_id: string, _ms: number) => ({
      promise: new Promise(() => {}),
      cancel,
    });

    const { loader, pluginId } = createTestLoader(FastPlugin);
    try {
      await loader.load(pluginId);
      expect(cancel).toHaveBeenCalled();
    } finally {
      (PluginLoader as any).lifecycleTimeout = origTimeout;
    }
  });
});

describe("PluginLoader — constructor instantiation", () => {
  it("instantiates plugin class only once during load", async () => {
    let constructorCalls = 0;

    class SingleConstructPlugin extends Plugin {
      constructor() {
        super();
        constructorCalls++;
      }

      async onLoad(): Promise<void> {}
      async onUnload(): Promise<void> {}
    }

    const { loader, pluginId } = createTestLoader(SingleConstructPlugin);
    await loader.load(pluginId);

    expect(constructorCalls).toBe(1);
  });
});

describe("PluginLoader — module export validation", () => {
  it("rejects a default export that is not a function", async () => {
    const eventBus = new EventBus();
    const services: PluginServices = {
      taskService: {} as any,
      projectService: {} as any,
      tagService: {} as any,
      eventBus,
      settingsManager: { load: vi.fn() } as any,
      commandRegistry: { unregisterByPlugin: vi.fn() } as any,
      uiRegistry: { removeByPlugin: vi.fn() } as any,
      queries: {
        getAppSetting: vi.fn().mockReturnValue({ value: "true" }),
        getPluginPermissions: vi.fn().mockReturnValue([]),
      } as any,
    };

    const loader = new PluginLoader("/tmp/test-plugins", services);
    loader.setModuleLoader(async () => ({ default: "not-a-class" }));

    (loader as any).plugins.set("bad-plugin", {
      manifest: {
        id: "bad-plugin",
        name: "Bad",
        version: "1.0.0",
        author: "test",
        description: "test",
        main: "index.js",
      },
      path: "/tmp/test-plugins/bad-plugin",
      enabled: false,
      builtin: true,
    });

    await expect(loader.load("bad-plugin")).rejects.toThrow(
      /does not have a default export class/,
    );
  });

  it("rejects a class missing onLoad method", async () => {
    const eventBus = new EventBus();
    const services: PluginServices = {
      taskService: {} as any,
      projectService: {} as any,
      tagService: {} as any,
      eventBus,
      settingsManager: { load: vi.fn() } as any,
      commandRegistry: { unregisterByPlugin: vi.fn() } as any,
      uiRegistry: { removeByPlugin: vi.fn() } as any,
      queries: {
        getAppSetting: vi.fn().mockReturnValue({ value: "true" }),
        getPluginPermissions: vi.fn().mockReturnValue([]),
      } as any,
    };

    const loader = new PluginLoader("/tmp/test-plugins", services);
    // A class with no onLoad
    class BadPlugin {
      onUnload() {}
    }
    loader.setModuleLoader(async () => ({ default: BadPlugin }));

    (loader as any).plugins.set("bad-plugin", {
      manifest: {
        id: "bad-plugin",
        name: "Bad",
        version: "1.0.0",
        author: "test",
        description: "test",
        main: "index.js",
      },
      path: "/tmp/test-plugins/bad-plugin",
      enabled: false,
      builtin: true,
    });

    await expect(loader.load("bad-plugin")).rejects.toThrow(
      /must have an onLoad\(\) method/,
    );
  });

  it("rejects a class missing onUnload method", async () => {
    const eventBus = new EventBus();
    const services: PluginServices = {
      taskService: {} as any,
      projectService: {} as any,
      tagService: {} as any,
      eventBus,
      settingsManager: { load: vi.fn() } as any,
      commandRegistry: { unregisterByPlugin: vi.fn() } as any,
      uiRegistry: { removeByPlugin: vi.fn() } as any,
      queries: {
        getAppSetting: vi.fn().mockReturnValue({ value: "true" }),
        getPluginPermissions: vi.fn().mockReturnValue([]),
      } as any,
    };

    const loader = new PluginLoader("/tmp/test-plugins", services);
    class BadPlugin {
      onLoad() {}
    }
    loader.setModuleLoader(async () => ({ default: BadPlugin }));

    (loader as any).plugins.set("bad-plugin", {
      manifest: {
        id: "bad-plugin",
        name: "Bad",
        version: "1.0.0",
        author: "test",
        description: "test",
        main: "index.js",
      },
      path: "/tmp/test-plugins/bad-plugin",
      enabled: false,
      builtin: true,
    });

    await expect(loader.load("bad-plugin")).rejects.toThrow(
      /must have an onUnload\(\) method/,
    );
  });
});
