import { describe, it, expect } from "vitest";
import { createPluginAPI } from "../../src/plugins/api.js";
import { createTestServices } from "../integration/helpers.js";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import { CommandRegistry } from "../../src/plugins/command-registry.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";
import type { Permission } from "../../src/plugins/types.js";

function createAPI(permissions: Permission[]) {
  const { taskService, eventBus, storage } = createTestServices();
  const uiRegistry = new UIRegistry();
  const api = createPluginAPI({
    pluginId: "test-react",
    permissions,
    taskService,
    eventBus,
    settingsManager: new PluginSettingsManager(storage),
    commandRegistry: new CommandRegistry(),
    uiRegistry,
    settingDefinitions: [],
  });
  return { api, uiRegistry };
}

describe("Plugin API — React component registration", () => {
  it("should register a React view via addView", () => {
    const { api, uiRegistry } = createAPI(["ui:view"]);
    const TestComponent = () => "hello";

    api.ui.addView!({
      id: "react-view",
      name: "React View",
      icon: "⚛️",
      contentType: "react",
      component: TestComponent,
    });

    const views = uiRegistry.getViews();
    expect(views).toHaveLength(1);
    expect(views[0].contentType).toBe("react");
    expect(views[0].component).toBe(TestComponent);
    expect(views[0].pluginId).toBe("test-react");
  });

  it("should register a React panel via addSidebarPanel", () => {
    const { api, uiRegistry } = createAPI(["ui:panel"]);
    const TestComponent = () => "panel content";

    api.ui.addSidebarPanel!({
      id: "react-panel",
      title: "React Panel",
      icon: "🔧",
      contentType: "react",
      component: TestComponent,
    });

    const panels = uiRegistry.getPanels();
    expect(panels).toHaveLength(1);
    expect(panels[0].contentType).toBe("react");
    expect(panels[0].component).toBe(TestComponent);
  });

  it("should default to text contentType for views", () => {
    const { api, uiRegistry } = createAPI(["ui:view"]);

    api.ui.addView!({
      id: "text-view",
      name: "Text View",
      icon: "📄",
      render: () => "hello",
    });

    const views = uiRegistry.getViews();
    expect(views[0].contentType).toBe("text");
  });

  it("should default to text contentType for panels", () => {
    const { api, uiRegistry } = createAPI(["ui:panel"]);

    api.ui.addSidebarPanel!({
      id: "text-panel",
      title: "Text Panel",
      icon: "📄",
      render: () => "hello",
    });

    const panels = uiRegistry.getPanels();
    expect(panels[0].contentType).toBe("text");
  });
});
