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

function writeManifest(
  rootDir: string,
  folderName: string,
  pluginId: string,
  overrides?: Record<string, unknown>,
): string {
  const pluginPath = path.join(rootDir, folderName);
  fs.mkdirSync(pluginPath, { recursive: true });
  const manifest = {
    id: pluginId,
    name: `Plugin ${pluginId}`,
    version: "1.0.0",
    author: "test",
    description: `Plugin ${pluginId}`,
    main: "index.mjs",
    minJunbanVersion: "1.0.0",
    permissions: ["task:read"],
    ...overrides,
  };
  fs.writeFileSync(
    path.join(pluginPath, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  fs.writeFileSync(path.join(pluginPath, "index.mjs"), "export default class P {}\n");
  return pluginPath;
}

function createLoader(pluginDir: string, builtinDir?: string): PluginLoader {
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

  return new PluginLoader(pluginDir, services, builtinDir);
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("PluginLoader discovery collisions", () => {
  it("rejects community plugin IDs that collide with built-in IDs", async () => {
    const communityDir = makeTmpDir("junban-plugins-");
    const builtinDir = makeTmpDir("junban-builtin-");

    const builtinPath = writeManifest(builtinDir, "collision-id", "collision-id");
    writeManifest(communityDir, "collision-id", "collision-id");

    const loader = createLoader(communityDir, builtinDir);
    const builtins = await loader.discoverBuiltin();
    const community = await loader.discover();

    expect(builtins).toHaveLength(1);
    expect(community).toHaveLength(0);

    const loaded = loader.get("collision-id");
    expect(loaded).toBeDefined();
    expect(loaded?.builtin).toBe(true);
    expect(loaded?.path).toBe(builtinPath);
  });

  it("gives built-ins precedence even when community is discovered first", async () => {
    const communityDir = makeTmpDir("junban-plugins-");
    const builtinDir = makeTmpDir("junban-builtin-");

    writeManifest(communityDir, "priority-id", "priority-id");
    const builtinPath = writeManifest(builtinDir, "priority-id", "priority-id");

    const loader = createLoader(communityDir, builtinDir);

    const communityFirst = await loader.discover();
    expect(communityFirst).toHaveLength(1);
    expect(loader.get("priority-id")?.builtin).toBeUndefined();

    const builtinsSecond = await loader.discoverBuiltin();
    expect(builtinsSecond).toHaveLength(1);

    const loaded = loader.get("priority-id");
    expect(loaded).toBeDefined();
    expect(loaded?.builtin).toBe(true);
    expect(loaded?.path).toBe(builtinPath);
  });

  it("rejects community-community duplicate IDs without overwriting", async () => {
    const communityDir = makeTmpDir("junban-plugins-");

    writeManifest(communityDir, "shared-id", "shared-id");
    // Invalid second plugin: manifest.id does not match directory name.
    writeManifest(communityDir, "plugin-b", "shared-id");

    const loader = createLoader(communityDir);
    const discovered = await loader.discover();

    expect(discovered).toHaveLength(1);
    expect(loader.getAll()).toHaveLength(1);
    expect(loader.get("shared-id")).toBeDefined();
  });

  it("rediscovery keeps existing plugin runtime state", async () => {
    const communityDir = makeTmpDir("junban-plugins-");

    writeManifest(communityDir, "rediscover-id", "rediscover-id");

    const loader = createLoader(communityDir);
    await loader.discover();

    const loaded = loader.get("rediscover-id");
    expect(loaded).toBeDefined();
    loaded!.enabled = true;

    const discoveredAgain = await loader.discover();
    expect(discoveredAgain).toHaveLength(1);
    expect(loader.get("rediscover-id")?.enabled).toBe(true);
  });

  it("discoverOne rejects manifest ID collisions from different folders", async () => {
    const communityDir = makeTmpDir("junban-plugins-");
    const builtinDir = makeTmpDir("junban-builtin-");

    const builtinPath = writeManifest(builtinDir, "reserved-id", "reserved-id");
    writeManifest(communityDir, "download-folder", "reserved-id");

    const loader = createLoader(communityDir, builtinDir);
    await loader.discoverBuiltin();

    const discovered = await loader.discoverOne("download-folder");
    expect(discovered).toBeNull();

    const loaded = loader.get("reserved-id");
    expect(loaded?.builtin).toBe(true);
    expect(loaded?.path).toBe(builtinPath);
  });

  it("discoverOne rejects when manifest.id does not match requested pluginId", async () => {
    const communityDir = makeTmpDir("junban-plugins-");

    writeManifest(communityDir, "download-folder", "different-id");

    const loader = createLoader(communityDir);
    const discovered = await loader.discoverOne("download-folder");

    expect(discovered).toBeNull();
    expect(loader.get("download-folder")).toBeUndefined();
    expect(loader.get("different-id")).toBeUndefined();
  });

  it("discover() rejects when manifest.id does not match directory name", async () => {
    const communityDir = makeTmpDir("junban-plugins-");

    writeManifest(communityDir, "folder-name", "different-id");

    const loader = createLoader(communityDir);
    const discovered = await loader.discover();

    expect(discovered).toHaveLength(0);
    expect(loader.get("folder-name")).toBeUndefined();
    expect(loader.get("different-id")).toBeUndefined();
  });

  it("discoverBuiltin() rejects when manifest.id does not match directory name", async () => {
    const communityDir = makeTmpDir("junban-plugins-");
    const builtinDir = makeTmpDir("junban-builtin-");

    writeManifest(builtinDir, "builtin-folder", "different-id");

    const loader = createLoader(communityDir, builtinDir);
    const discovered = await loader.discoverBuiltin();

    expect(discovered).toHaveLength(0);
    expect(loader.get("builtin-folder")).toBeUndefined();
    expect(loader.get("different-id")).toBeUndefined();
  });
});
