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
  pluginId: string,
  code: string,
  additionalFiles?: Record<string, string>,
): string {
  const pluginPath = path.join(rootDir, pluginId);
  fs.mkdirSync(pluginPath, { recursive: true });
  fs.writeFileSync(
    path.join(pluginPath, "manifest.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: `Plugin ${pluginId}`,
        version: "1.0.0",
        author: "test",
        description: `Plugin ${pluginId}`,
        main: "index.mjs",
        minJunbanVersion: "1.0.0",
        permissions: ["commands"],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(pluginPath, "index.mjs"), code);
  for (const [relativePath, fileContent] of Object.entries(additionalFiles ?? {})) {
    const fullPath = path.join(pluginPath, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, fileContent);
  }
  return pluginPath;
}

function createLoader(pluginDir: string, builtinDir?: string): {
  loader: PluginLoader;
  services: PluginServices;
  testServices: ReturnType<typeof createTestServices>;
} {
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

  const loader = new PluginLoader(pluginDir, services, builtinDir);
  return { loader, services, testServices };
}

function commandNameFor(services: PluginServices, pluginId: string): string | undefined {
  return services.commandRegistry
    .getAll()
    .find((cmd) => cmd.id === `${pluginId}:version`)?.name;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("PluginLoader module cache behavior", () => {
  it("reloads updated built-in plugin code after unload/load at same path", async () => {
    const communityDir = makeTmpDir("junban-community-");
    const builtinDir = makeTmpDir("junban-builtin-");
    const pluginId = "builtin-reload";

    writePlugin(
      builtinDir,
      pluginId,
      `
export default class BuiltinPlugin {
  async onLoad() {
    this.app.commands.register({ id: "version", name: "v1", callback: () => {} });
  }
  async onUnload() {}
}
`,
    );

    const { loader, services, testServices } = createLoader(communityDir, builtinDir);
    await loader.discoverBuiltin();

    // Built-ins are only activated after explicit approval marker exists.
    testServices.storage.setPluginPermissions(pluginId, []);

    await loader.load(pluginId);
    expect(commandNameFor(services, pluginId)).toBe("v1");

    await loader.unload(pluginId);

    writePlugin(
      builtinDir,
      pluginId,
      `
export default class BuiltinPlugin {
  async onLoad() {
    this.app.commands.register({ id: "version", name: "v2", callback: () => {} });
  }
  async onUnload() {}
}
`,
    );

    await loader.load(pluginId);
    expect(commandNameFor(services, pluginId)).toBe("v2");
  });

  it("reloads updated community plugin code after unload + rediscoverOne at same path", async () => {
    const pluginDir = makeTmpDir("junban-community-");
    const pluginId = "community-reload";

    writePlugin(
      pluginDir,
      pluginId,
      `
export default class CommunityPlugin {
  async onLoad() {
    this.app.commands.register({ id: "version", name: "v1", callback: () => {} });
  }
  async onUnload() {}
}
`,
    );

    const { loader, services } = createLoader(pluginDir);
    await loader.discover();
    await loader.approveAndLoad(pluginId, ["commands"]);
    expect(commandNameFor(services, pluginId)).toBe("v1");

    await loader.unload(pluginId);

    writePlugin(
      pluginDir,
      pluginId,
      `
export default class CommunityPlugin {
  async onLoad() {
    this.app.commands.register({ id: "version", name: "v2", callback: () => {} });
  }
  async onUnload() {}
}
`,
    );

    // Simulate install/update rediscovery where the plugin directory path stays the same.
    await loader.discoverOne(pluginId);
    await loader.approveAndLoad(pluginId, ["commands"]);

    expect(commandNameFor(services, pluginId)).toBe("v2");
  });

  it("reloads updated built-in dependency modules in native import mode", async () => {
    const communityDir = makeTmpDir("junban-community-");
    const builtinDir = makeTmpDir("junban-builtin-");
    const pluginId = "builtin-dependency-reload";

    writePlugin(
      builtinDir,
      pluginId,
      `
import { commandLabel } from "./deps/label.mjs";

export default class BuiltinPlugin {
  async onLoad() {
    this.app.commands.register({ id: "version", name: commandLabel, callback: () => {} });
  }
  async onUnload() {}
}
`,
      {
        "deps/label.mjs": 'export const commandLabel = "dep-v1";\n',
      },
    );

    const { loader, services, testServices } = createLoader(communityDir, builtinDir);
    await loader.discoverBuiltin();
    testServices.storage.setPluginPermissions(pluginId, []);

    await loader.load(pluginId);
    expect(commandNameFor(services, pluginId)).toBe("dep-v1");

    await loader.unload(pluginId);

    writePlugin(
      builtinDir,
      pluginId,
      `
import { commandLabel } from "./deps/label.mjs";

export default class BuiltinPlugin {
  async onLoad() {
    this.app.commands.register({ id: "version", name: commandLabel, callback: () => {} });
  }
  async onUnload() {}
}
`,
      {
        "deps/label.mjs": 'export const commandLabel = "dep-v2";\n',
      },
    );

    await loader.load(pluginId);
    expect(commandNameFor(services, pluginId)).toBe("dep-v2");
  });
});
