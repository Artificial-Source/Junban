/**
 * End-to-end plugin lifecycle integration tests.
 *
 * Tests the FULL plugin lifecycle using a real PluginLoader with temporary
 * filesystem plugins written as .mjs ESM modules.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestServices } from "../integration/helpers.js";
import { PluginLoader, type PluginServices } from "../../src/plugins/loader.js";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import { CommandRegistry } from "../../src/plugins/command-registry.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpPluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junban-plugin-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writePlugin(
  pluginDir: string,
  pluginId: string,
  manifest: Record<string, unknown>,
  code: string,
): string {
  const dir = path.join(pluginDir, pluginId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  fs.writeFileSync(path.join(dir, "index.mjs"), code);
  return dir;
}

function makeManifest(
  id: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    name: `Test Plugin ${id}`,
    version: "1.0.0",
    author: "test",
    description: `Test plugin ${id}`,
    main: "index.mjs",
    minJunbanVersion: "1.0.0",
    permissions: ["task:read", "task:write", "commands", "settings"],
    ...overrides,
  };
}

function createLoaderWithServices(pluginDir: string): {
  loader: PluginLoader;
  services: PluginServices;
  testServices: ReturnType<typeof createTestServices>;
} {
  const testServices = createTestServices();
  const settingsManager = new PluginSettingsManager(testServices.storage);
  const commandRegistry = new CommandRegistry();
  const uiRegistry = new UIRegistry();

  const services: PluginServices = {
    taskService: testServices.taskService,
    projectService: testServices.projectService,
    tagService: testServices.tagService,
    eventBus: testServices.eventBus,
    settingsManager,
    commandRegistry,
    uiRegistry,
    queries: testServices.storage,
  };

  // Enable community plugins
  testServices.storage.setAppSetting("community_plugins_enabled", "true");

  const loader = new PluginLoader(pluginDir, services);
  return { loader, services, testServices };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Plugin E2E lifecycle", () => {
  // ── 1. Full happy path ──────────────────────────────────────────────────

  it("full happy path: discover -> approve -> load -> events -> settings -> unload", async () => {
    const pluginDir = makeTmpPluginDir();
    const pluginId = "happy-plugin";

    writePlugin(
      pluginDir,
      pluginId,
      makeManifest(pluginId, {
        settings: [
          { id: "greeting", name: "Greeting", type: "text", default: "hello" },
        ],
      }),
      `
let loadCalled = false;
let taskEvents = [];

export default class HappyPlugin {
  async onLoad() {
    loadCalled = true;
    this.app.commands.register({
      id: "greet",
      name: "Greet",
      callback: () => {},
    });
  }

  async onUnload() {}

  onTaskCreate(task) {
    taskEvents.push(task);
  }
}

export { loadCalled, taskEvents };
`,
    );

    const { loader, services, testServices } = createLoaderWithServices(pluginDir);

    // Discover
    const discovered = await loader.discover();
    expect(discovered).toHaveLength(1);
    expect(discovered[0].manifest.id).toBe(pluginId);

    // Approve permissions and load
    await loader.approveAndLoad(pluginId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);

    // Verify loaded
    const plugin = loader.get(pluginId);
    expect(plugin).toBeDefined();
    expect(plugin!.enabled).toBe(true);
    expect(plugin!.instance).toBeDefined();

    // Verify command registered
    const commands = services.commandRegistry.getAll();
    const greetCmd = commands.find((c) => c.id === `${pluginId}:greet`);
    expect(greetCmd).toBeDefined();
    expect(greetCmd!.name).toBe("Greet");

    // Fire a task event and verify hook listener was registered
    const initialListenerCount =
      testServices.eventBus.listenerCount("task:create");
    expect(initialListenerCount).toBeGreaterThanOrEqual(1);

    await testServices.taskService.create({
      title: "Test task for hook",
      dueTime: false,
    });

    // Verify settings persistence
    await services.settingsManager.load(pluginId);
    expect(plugin!.instance!.settings.get("greeting")).toBe("hello");
    await plugin!.instance!.settings.set("greeting", "world");
    expect(plugin!.instance!.settings.get("greeting")).toBe("world");

    // Unload
    await loader.unload(pluginId);
    const afterUnload = loader.get(pluginId);
    expect(afterUnload!.enabled).toBe(false);
    expect(afterUnload!.instance).toBeUndefined();

    // Verify commands cleaned up
    const commandsAfter = services.commandRegistry.getAll();
    const greetCmdAfter = commandsAfter.find(
      (c) => c.id === `${pluginId}:greet`,
    );
    expect(greetCmdAfter).toBeUndefined();
  });

  // ── 2. Plugin that throws in onLoad ─────────────────────────────────────

  it("plugin that throws in onLoad fails gracefully", async () => {
    const pluginDir = makeTmpPluginDir();
    const throwId = "throw-plugin";
    const goodId = "good-plugin";

    writePlugin(
      pluginDir,
      throwId,
      makeManifest(throwId),
      `
export default class ThrowPlugin {
  async onLoad() {
    throw new Error("Boom in onLoad!");
  }
  async onUnload() {}
}
`,
    );

    writePlugin(
      pluginDir,
      goodId,
      makeManifest(goodId),
      `
export default class GoodPlugin {
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    const { loader, testServices } = createLoaderWithServices(pluginDir);

    await loader.discover();

    // Approve and load the throwing plugin — should fail
    testServices.storage.setPluginPermissions(throwId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);
    await expect(loader.load(throwId)).rejects.toThrow("Boom in onLoad!");

    const throwPlugin = loader.get(throwId);
    expect(throwPlugin!.enabled).toBe(false);

    // The good plugin should still load fine
    await loader.approveAndLoad(goodId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);

    const goodPlugin = loader.get(goodId);
    expect(goodPlugin!.enabled).toBe(true);
  });

  // ── 3. Plugin that times out ────────────────────────────────────────────

  it("plugin that times out in onLoad is rejected", async () => {
    const pluginDir = makeTmpPluginDir();
    const pluginId = "timeout-plugin";

    // Plugin whose onLoad delays for 500ms — longer than our 100ms timeout
    writePlugin(
      pluginDir,
      pluginId,
      makeManifest(pluginId),
      `
export default class TimeoutPlugin {
  async onLoad() {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  async onUnload() {}
}
`,
    );

    const { loader, testServices } = createLoaderWithServices(pluginDir);

    await loader.discover();
    testServices.storage.setPluginPermissions(pluginId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);

    // Patch the private static lifecycleTimeout to use a short timeout.
    // The loader calls PluginLoader.lifecycleTimeout(id, PLUGIN_LOAD_TIMEOUT_MS)
    // inside load(). We override the static method to always use 100ms.
    const origTimeout = (PluginLoader as any).lifecycleTimeout;
    (PluginLoader as any).lifecycleTimeout = (id: string, _ms: number) =>
      origTimeout.call(PluginLoader, id, 100);

    await expect(loader.load(pluginId)).rejects.toThrow(/timed out/);

    // Restore original
    (PluginLoader as any).lifecycleTimeout = origTimeout;

    const plugin = loader.get(pluginId);
    expect(plugin!.enabled).toBe(false);
  });

  // ── 4. Bad module export ────────────────────────────────────────────────

  it("plugin with bad module export (plain object) gives validation error", async () => {
    const pluginDir = makeTmpPluginDir();
    const pluginId = "bad-export";

    writePlugin(
      pluginDir,
      pluginId,
      makeManifest(pluginId),
      `
// Export a plain object instead of a class
export default { onLoad: () => {}, onUnload: () => {} };
`,
    );

    const { loader, testServices } = createLoaderWithServices(pluginDir);

    await loader.discover();
    testServices.storage.setPluginPermissions(pluginId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);

    await expect(loader.load(pluginId)).rejects.toThrow(
      /does not have a default export class/,
    );

    const plugin = loader.get(pluginId);
    expect(plugin!.enabled).toBe(false);
  });

  // ── 5. Hook crash isolation ─────────────────────────────────────────────

  it("plugin onTaskCreate hook crash does not crash the app", async () => {
    const pluginDir = makeTmpPluginDir();
    const pluginId = "crash-hook";

    writePlugin(
      pluginDir,
      pluginId,
      makeManifest(pluginId),
      `
export default class CrashHookPlugin {
  async onLoad() {}
  async onUnload() {}

  onTaskCreate(task) {
    throw new Error("Hook crash!");
  }
}
`,
    );

    const { loader, testServices } = createLoaderWithServices(pluginDir);

    await loader.discover();
    await loader.approveAndLoad(pluginId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);

    const plugin = loader.get(pluginId);
    expect(plugin!.enabled).toBe(true);

    // Creating a task should NOT throw even though the hook does
    const task = await testServices.taskService.create({
      title: "Should not crash",
      dueTime: false,
    });

    expect(task).toBeDefined();
    expect(task.title).toBe("Should not crash");

    // Plugin should still be loaded (not disabled by a hook crash)
    expect(plugin!.enabled).toBe(true);
  });

  it("community plugins run in isolated sandbox context", async () => {
    const pluginDir = makeTmpPluginDir();
    const pluginId = "sandbox-isolation";

    writePlugin(
      pluginDir,
      pluginId,
      makeManifest(pluginId, {
        settings: [{ id: "probe", name: "Probe", type: "text", default: "" }],
      }),
      `
export default class IsolationPlugin {
  async onLoad() {
    let nodeBuiltinBlocked = false;
    try {
      require("node:fs");
    } catch {
      nodeBuiltinBlocked = true;
    }

    await this.settings.set("probe", JSON.stringify({
      processType: typeof process,
      globalType: typeof global,
      hostProcessType: typeof globalThis.process,
      nodeBuiltinBlocked,
    }));
  }
  async onUnload() {}
}
`,
    );

    const { loader } = createLoaderWithServices(pluginDir);
    await loader.discover();
    await loader.approveAndLoad(pluginId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);

    const plugin = loader.get(pluginId);
    const probeRaw = plugin?.instance?.settings.get<string>("probe");
    const probe = JSON.parse(probeRaw ?? "{}");

    expect(probe).toEqual({
      processType: "undefined",
      globalType: "undefined",
      hostProcessType: "undefined",
      nodeBuiltinBlocked: true,
    });
  });

  // ── 6. Unload cleanup ──────────────────────────────────────────────────

  it("unload removes EventBus listeners and hooks no longer fire", async () => {
    const pluginDir = makeTmpPluginDir();
    const pluginId = "cleanup-plugin";

    writePlugin(
      pluginDir,
      pluginId,
      makeManifest(pluginId),
      `
let hookCallCount = 0;

export default class CleanupPlugin {
  async onLoad() {}
  async onUnload() {}

  onTaskCreate(task) {
    hookCallCount++;
  }
}

export { hookCallCount };
`,
    );

    const { loader, testServices } = createLoaderWithServices(pluginDir);

    await loader.discover();
    await loader.approveAndLoad(pluginId, [
      "task:read",
      "task:write",
      "commands",
      "settings",
    ]);

    // Verify EventBus listener was added for task:create
    const listenersBefore =
      testServices.eventBus.listenerCount("task:create");
    expect(listenersBefore).toBeGreaterThanOrEqual(1);

    // Create a task before unload — hook fires
    await testServices.taskService.create({
      title: "Before unload",
      dueTime: false,
    });

    // Unload the plugin
    await loader.unload(pluginId);

    // Verify EventBus listeners removed
    const listenersAfter =
      testServices.eventBus.listenerCount("task:create");
    expect(listenersAfter).toBe(listenersBefore - 1);

    // Create another task after unload — hook should NOT fire
    await testServices.taskService.create({
      title: "After unload",
      dueTime: false,
    });

    // Plugin state reflects unloaded
    const plugin = loader.get(pluginId);
    expect(plugin!.enabled).toBe(false);
    expect(plugin!.instance).toBeUndefined();
  });
});
