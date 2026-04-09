import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestServices } from "../integration/helpers.js";
import { PluginLoader, type PluginServices } from "../../src/plugins/loader.js";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import { CommandRegistry } from "../../src/plugins/command-registry.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writePlugin(
  rootDir: string,
  folderName: string,
  manifestOverrides?: Record<string, unknown>,
): void {
  const pluginPath = path.join(rootDir, folderName);
  fs.mkdirSync(pluginPath, { recursive: true });

  const manifest = {
    id: folderName,
    name: `Plugin ${folderName}`,
    version: "1.0.0",
    author: "test",
    description: `Plugin ${folderName}`,
    main: "index.mjs",
    minJunbanVersion: "1.0.0",
    permissions: [],
    ...manifestOverrides,
  };

  fs.writeFileSync(
    path.join(pluginPath, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  fs.writeFileSync(
    path.join(pluginPath, "index.mjs"),
    "export default class P { async onLoad() {} async onUnload() {} }\n",
  );
}

function createLoader(pluginDir: string): PluginLoader {
  const testServices = createTestServices();
  testServices.storage.setAppSetting("community_plugins_enabled", "true");

  const services: PluginServices = {
    taskService: testServices.taskService,
    projectService: testServices.projectService,
    tagService: testServices.tagService,
    eventBus: testServices.eventBus,
    settingsManager: new PluginSettingsManager(testServices.storage),
    commandRegistry: new CommandRegistry(),
    uiRegistry: new UIRegistry(),
    queries: testServices.storage,
  };

  return new PluginLoader(pluginDir, services);
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("PluginLoader compatibility enforcement", () => {
  it("rejects discovery when minJunbanVersion is above host version", async () => {
    const pluginDir = makeTmpDir("junban-plugins-");
    writePlugin(pluginDir, "too-new", { minJunbanVersion: "999.0.0" });

    const loader = createLoader(pluginDir);
    const discovered = await loader.discover();

    expect(discovered).toHaveLength(0);
    expect(loader.get("too-new")).toBeUndefined();
  });

  it("rejects discovery when targetApiVersion major is incompatible", async () => {
    const pluginDir = makeTmpDir("junban-plugins-");
    writePlugin(pluginDir, "wrong-api-major", { targetApiVersion: "9.0.0" });

    const loader = createLoader(pluginDir);
    const discovered = await loader.discover();

    expect(discovered).toHaveLength(0);
    expect(loader.get("wrong-api-major")).toBeUndefined();
  });

  it("fails load when a declared dependency is missing", async () => {
    const pluginDir = makeTmpDir("junban-plugins-");
    writePlugin(pluginDir, "needs-missing", {
      dependencies: { "not-installed": "^1.0.0" },
    });

    const loader = createLoader(pluginDir);
    await loader.discover();

    await expect(loader.load("needs-missing")).rejects.toThrow(
      /requires dependency "not-installed"/,
    );
  });

  it("loads dependencies first when constraints are satisfied", async () => {
    const pluginDir = makeTmpDir("junban-plugins-");
    writePlugin(pluginDir, "dep", { version: "1.3.0" });
    writePlugin(pluginDir, "consumer", { dependencies: { dep: "^1.0.0" } });

    const loader = createLoader(pluginDir);
    await loader.discover();
    await loader.load("consumer");

    expect(loader.get("dep")?.enabled).toBe(true);
    expect(loader.get("consumer")?.enabled).toBe(true);
  });

  it("fails load when dependency version does not satisfy constraint", async () => {
    const pluginDir = makeTmpDir("junban-plugins-");
    writePlugin(pluginDir, "dep", { version: "1.1.0" });
    writePlugin(pluginDir, "consumer", { dependencies: { dep: "^2.0.0" } });

    const loader = createLoader(pluginDir);
    await loader.discover();

    await expect(loader.load("consumer")).rejects.toThrow(
      /does not satisfy "\^2\.0\.0"/,
    );
  });

  it("fails load when dependencies contain a circular chain", async () => {
    const pluginDir = makeTmpDir("junban-plugins-");
    writePlugin(pluginDir, "plugin-a", { dependencies: { "plugin-b": "^1.0.0" } });
    writePlugin(pluginDir, "plugin-b", { dependencies: { "plugin-a": "^1.0.0" } });

    const loader = createLoader(pluginDir);
    await loader.discover();

    await expect(loader.load("plugin-a")).rejects.toThrow(
      /Circular plugin dependency detected/,
    );
  });
});
