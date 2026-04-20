import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatManager } from "../../src/ai/chat.js";
import { createDefaultRegistry } from "../../src/ai/provider-node.js";
import { createDefaultToolRegistry } from "../../src/ai/tool-registry.js";
import { createBackendKernel } from "../../src/backend/kernel.js";
import { PluginLoader } from "../../src/plugins/loader.js";
import { createTestServices } from "../integration/helpers.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createKernelAIRuntime() {
  return {
    chatManager: new ChatManager(),
    aiProviderRegistry: createDefaultRegistry(),
    toolRegistry: createDefaultToolRegistry(),
  };
}

describe("createBackendKernel", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("composes backend services around provided infrastructure", async () => {
    const { storage } = createTestServices();
    const pluginDir = makeTempDir("junban-backend-kernel-plugins-");
    const builtinPluginDir = makeTempDir("junban-backend-kernel-builtins-");
    tempDirs.push(pluginDir, builtinPluginDir);
    const createPluginLoader = vi.fn(
      (pluginServices: ConstructorParameters<typeof PluginLoader>[1]) =>
        new PluginLoader(pluginDir, pluginServices, builtinPluginDir),
    );

    const services = createBackendKernel({
      storage,
      aiRuntime: createKernelAIRuntime(),
      createPluginLoader,
    });

    expect(services.storage).toBe(storage);
    expect(createPluginLoader).toHaveBeenCalledTimes(1);

    const createdTask = await services.taskService.create({ title: "Kernel task" });
    expect(createdTask.title).toBe("Kernel task");

    await expect(services.pluginLoader.loadAll()).resolves.toBeUndefined();
    expect(services.pluginLoader.getAll()).toEqual([]);
  });

  it("reuses injected runtime services when provided", () => {
    const { storage } = createTestServices();
    const pluginDir = makeTempDir("junban-backend-kernel-plugins-");
    tempDirs.push(pluginDir);

    const aiRuntime = createKernelAIRuntime();
    const createPluginLoader = (pluginServices: ConstructorParameters<typeof PluginLoader>[1]) =>
      new PluginLoader(pluginDir, pluginServices);

    const services = createBackendKernel({
      storage,
      aiRuntime,
      createPluginLoader,
    });

    expect(services.chatManager).toBe(aiRuntime.chatManager);
    expect(services.aiProviderRegistry).toBe(aiRuntime.aiProviderRegistry);
    expect(services.toolRegistry).toBe(aiRuntime.toolRegistry);
  });
});
