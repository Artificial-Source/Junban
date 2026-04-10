import { describe, expect, it } from "vitest";
import { createPluginAPI } from "../../src/plugins/api.js";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import { CommandRegistry } from "../../src/plugins/command-registry.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";
import { createTestServices } from "../integration/helpers.js";

describe("Plugin API AI tool registration", () => {
  it("scopes plugin tool names to avoid collisions", async () => {
    const { taskService, projectService, tagService, eventBus, storage } = createTestServices();
    const toolRegistry = new ToolRegistry();

    toolRegistry.register(
      { name: "create_task", description: "Built-in", parameters: { type: "object" } },
      async () => JSON.stringify({ source: "builtin" }),
      "builtin",
    );

    const api = createPluginAPI({
      pluginId: "my-plugin",
      permissions: ["ai:tools"],
      taskService,
      projectService,
      tagService,
      eventBus,
      settingsManager: new PluginSettingsManager(storage),
      commandRegistry: new CommandRegistry(),
      uiRegistry: new UIRegistry(),
      settingDefinitions: [],
      toolRegistry,
    });

    api.ai.registerTool(
      { name: "create_task", description: "Plugin tool", parameters: { type: "object" } },
      async () => JSON.stringify({ source: "plugin" }),
    );

    expect(toolRegistry.has("create_task")).toBe(true);
    expect(toolRegistry.has("my-plugin__create_task")).toBe(true);

    const result = await toolRegistry.execute(
      "my-plugin__create_task",
      {},
      { taskService, projectService },
    );
    expect(JSON.parse(result)).toEqual({ source: "plugin" });
  });
});
