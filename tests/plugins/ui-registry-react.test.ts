import { describe, it, expect } from "vitest";
import { UIRegistry } from "../../src/plugins/ui-registry.js";
import type { PluginComponent } from "../../src/plugins/ui-registry.js";

describe("UIRegistry — React component support", () => {
  it("should store view with contentType react and component", () => {
    const registry = new UIRegistry();
    const TestComponent: PluginComponent = () => "hello";

    registry.addView({
      id: "test-view",
      pluginId: "test-plugin",
      name: "Test View",
      icon: "📦",
      slot: "tools",
      contentType: "react",
      component: TestComponent,
    });

    const views = registry.getViews();
    expect(views).toHaveLength(1);
    expect(views[0].contentType).toBe("react");
    expect(views[0].component).toBe(TestComponent);
  });

  it("should store panel with contentType react and component", () => {
    const registry = new UIRegistry();
    const TestComponent: PluginComponent = () => "panel content";

    registry.addPanel({
      id: "test-panel",
      pluginId: "test-plugin",
      title: "Test Panel",
      icon: "🔧",
      contentType: "react",
      component: TestComponent,
    });

    const panels = registry.getPanels();
    expect(panels).toHaveLength(1);
    expect(panels[0].contentType).toBe("react");
    expect(panels[0].component).toBe(TestComponent);
  });

  it("should still support text views without component", () => {
    const registry = new UIRegistry();

    registry.addView({
      id: "text-view",
      pluginId: "test-plugin",
      name: "Text View",
      icon: "📄",
      slot: "tools",
      contentType: "text",
      getContent: () => "hello text",
    });

    const views = registry.getViews();
    expect(views).toHaveLength(1);
    expect(views[0].contentType).toBe("text");
    expect(views[0].component).toBeUndefined();
    expect(registry.getViewContent("text-view")).toBe("hello text");
  });

  it("should still support structured views", () => {
    const registry = new UIRegistry();

    registry.addView({
      id: "structured-view",
      pluginId: "test-plugin",
      name: "Structured View",
      icon: "📊",
      slot: "tools",
      contentType: "structured",
      getContent: () => JSON.stringify({ type: "text", value: "hi" }),
    });

    const views = registry.getViews();
    expect(views).toHaveLength(1);
    expect(views[0].contentType).toBe("structured");
  });

  it("should return undefined for getViewContent on react views", () => {
    const registry = new UIRegistry();
    const TestComponent: PluginComponent = () => "hello";

    registry.addView({
      id: "react-view",
      pluginId: "test-plugin",
      name: "React View",
      icon: "⚛️",
      slot: "tools",
      contentType: "react",
      component: TestComponent,
    });

    // React views don't have getContent
    expect(registry.getViewContent("react-view")).toBeUndefined();
  });

  it("should remove react views by plugin", () => {
    const registry = new UIRegistry();
    const TestComponent: PluginComponent = () => "hello";

    registry.addView({
      id: "react-view",
      pluginId: "plugin-a",
      name: "React View",
      icon: "⚛️",
      slot: "tools",
      contentType: "react",
      component: TestComponent,
    });

    registry.removeByPlugin("plugin-a");
    expect(registry.getViews()).toHaveLength(0);
  });
});
