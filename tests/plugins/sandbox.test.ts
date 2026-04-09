import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSandbox, type SandboxOptions } from "../../src/plugins/sandbox.js";

describe("createSandbox", () => {
  const tempDirs: string[] = [];

  const makePluginDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junban-sandbox-test-"));
    tempDirs.push(dir);
    return dir;
  };

  const writePluginFile = (pluginDir: string, relativePath: string, source: string) => {
    const fullPath = path.join(pluginDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, source);
    return fullPath;
  };

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  const defaultOptions: SandboxOptions = {
    pluginId: "test-plugin",
    pluginDir: os.tmpdir(),
    permissions: ["tasks:read", "tasks:write"],
  };

  it("creates a sandbox with execute and destroy methods", () => {
    const sandbox = createSandbox(defaultOptions);
    expect(sandbox).toBeDefined();
    expect(typeof sandbox.execute).toBe("function");
    expect(typeof sandbox.destroy).toBe("function");
  });

  it("loads a local plugin module", async () => {
    const pluginDir = makePluginDir();
    const entry = writePluginFile(
      pluginDir,
      "index.mjs",
      `
const { value } = require("./util.mjs");

export default class TestPlugin {
  static marker = value;
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    writePluginFile(pluginDir, "util.mjs", `module.exports.value = "ok";`);

    const sandbox = createSandbox({
      ...defaultOptions,
      pluginDir,
    });

    const module = await sandbox.execute(entry);
    expect(typeof module.default).toBe("function");
    expect((module.default as { marker: string }).marker).toBe("ok");
  });

  it("destroy does not throw", () => {
    const sandbox = createSandbox(defaultOptions);
    expect(() => sandbox.destroy()).not.toThrow();
  });

  it("works with empty permissions", () => {
    const sandbox = createSandbox({
      ...defaultOptions,
      permissions: [],
    });
    expect(sandbox).toBeDefined();
  });

  it("works with different plugin IDs", () => {
    const sandbox1 = createSandbox({ ...defaultOptions, pluginId: "plugin-a" });
    const sandbox2 = createSandbox({ ...defaultOptions, pluginId: "plugin-b" });
    expect(sandbox1).toBeDefined();
    expect(sandbox2).toBeDefined();
  });

  it("blocks Node built-in imports", async () => {
    const pluginDir = makePluginDir();
    const entry = writePluginFile(
      pluginDir,
      "index.mjs",
      `
const fs = require("node:fs");
void fs;

export default class TestPlugin {
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    const sandbox = createSandbox({
      ...defaultOptions,
      pluginDir,
    });

    await expect(sandbox.execute(entry)).rejects.toThrow(
      /cannot import Node built-in modules/,
    );
  });

  it("does not false-reject import-like text in strings/comments", async () => {
    const pluginDir = makePluginDir();
    const entry = writePluginFile(
      pluginDir,
      "index.mjs",
      `
const text = 'import("./fake.mjs")';
/*
import x from "y";
*/

module.exports.marker = text;

export default class TestPlugin {
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    const sandbox = createSandbox({
      ...defaultOptions,
      pluginDir,
    });

    const module = await sandbox.execute(entry);
    expect((module as { marker?: string }).marker).toContain("import(");
  });

  it("rejects import.meta with a clear sandbox error", async () => {
    const pluginDir = makePluginDir();
    const entry = writePluginFile(
      pluginDir,
      "index.mjs",
      `
const url = import.meta.url;
void url;

export default class TestPlugin {
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    const sandbox = createSandbox({
      ...defaultOptions,
      pluginDir,
    });

    await expect(sandbox.execute(entry)).rejects.toThrow(
      /cannot use import.meta in community sandbox/,
    );
  });

  it("does not expose process/global host objects", async () => {
    const pluginDir = makePluginDir();
    const entry = writePluginFile(
      pluginDir,
      "index.mjs",
      `
module.exports.probe = {
  processType: typeof process,
  globalType: typeof global,
  hostProcessType: typeof globalThis.process,
};

export default class TestPlugin {
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    const sandbox = createSandbox({
      ...defaultOptions,
      pluginDir,
    });

    const module = await sandbox.execute(entry);
    const probe = (module as { probe?: Record<string, string> }).probe;
    expect(probe).toEqual({
      processType: "undefined",
      globalType: "undefined",
      hostProcessType: "undefined",
    });
  });

  it("blocks symlink escapes outside plugin root", async () => {
    const pluginDir = makePluginDir();
    const outsideDir = makePluginDir();
    const outsideFile = writePluginFile(
      outsideDir,
      "outside.mjs",
      `module.exports.secret = true;`,
    );

    fs.symlinkSync(outsideFile, path.join(pluginDir, "escape.mjs"));
    const entry = writePluginFile(
      pluginDir,
      "index.mjs",
      `
const escaped = require("./escape.mjs");
void escaped;

export default class TestPlugin {
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    const sandbox = createSandbox({
      ...defaultOptions,
      pluginDir,
    });

    await expect(sandbox.execute(entry)).rejects.toThrow(
      /attempted to import outside its directory/,
    );
  });

  it("destroy clears active intervals and timeouts", async () => {
    const pluginDir = makePluginDir();
    const entry = writePluginFile(
      pluginDir,
      "index.mjs",
      `
let ticks = 0;
setInterval(() => {
  ticks++;
}, 5);
setTimeout(() => {
  ticks += 1000;
}, 100);

module.exports.getTicks = () => ticks;

export default class TestPlugin {
  async onLoad() {}
  async onUnload() {}
}
`,
    );

    const sandbox = createSandbox({
      ...defaultOptions,
      pluginDir,
    });

    const mod = (await sandbox.execute(entry)) as { getTicks?: () => number };
    expect(typeof mod.getTicks).toBe("function");

    await new Promise((resolve) => setTimeout(resolve, 25));
    const beforeDestroy = mod.getTicks!();
    expect(beforeDestroy).toBeGreaterThan(0);

    sandbox.destroy();

    await new Promise((resolve) => setTimeout(resolve, 35));
    const afterDestroy = mod.getTicks!();
    expect(afterDestroy).toBe(beforeDestroy);
  });
});
