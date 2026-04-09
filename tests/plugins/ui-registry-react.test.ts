import { describe, it, expect, vi } from "vitest";
import { UIRegistry } from "../../src/plugins/ui-registry.js";
import type { PluginComponent } from "../../src/plugins/ui-registry.js";

describe("UIRegistry — React component support", () => {
  it("namespaces UI registration IDs by plugin ID", () => {
    const registry = new UIRegistry();

    registry.addPanel({
      id: "panel",
      pluginId: "plugin-a",
      title: "Panel",
      icon: "🔧",
      contentType: "text",
      getContent: () => "panel content",
    });
    registry.addView({
      id: "view",
      pluginId: "plugin-a",
      name: "View",
      icon: "👀",
      slot: "tools",
      contentType: "text",
      getContent: () => "view content",
    });
    registry.addStatusBarItem({
      id: "status",
      pluginId: "plugin-a",
      text: "Ready",
      icon: "✅",
    });

    expect(registry.getPanels()[0].id).toBe("plugin-a:panel");
    expect(registry.getViews()[0].id).toBe("plugin-a:view");
    expect(registry.getStatusBarItems()[0].id).toBe("plugin-a:status");
    expect(registry.getPanelContent("plugin-a:panel")).toBe("panel content");
    expect(registry.getViewContent("plugin-a:view")).toBe("view content");
  });

  it("does not double-prefix IDs already in the plugin namespace", () => {
    const registry = new UIRegistry();

    registry.addPanel({
      id: "plugin-a:panel",
      pluginId: "plugin-a",
      title: "Panel",
      icon: "🔧",
      contentType: "text",
      getContent: () => "content",
    });

    expect(registry.getPanels()[0].id).toBe("plugin-a:panel");
  });

  it("does not clobber same local IDs across different plugins", () => {
    const registry = new UIRegistry();

    registry.addView({
      id: "shared-view",
      pluginId: "plugin-a",
      name: "A View",
      icon: "A",
      slot: "tools",
      contentType: "text",
      getContent: () => "A content",
    });
    registry.addView({
      id: "shared-view",
      pluginId: "plugin-b",
      name: "B View",
      icon: "B",
      slot: "tools",
      contentType: "text",
      getContent: () => "B content",
    });

    const views = registry.getViews();
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.id).sort()).toEqual([
      "plugin-a:shared-view",
      "plugin-b:shared-view",
    ]);
    expect(registry.getViewContent("plugin-a:shared-view")).toBe("A content");
    expect(registry.getViewContent("plugin-b:shared-view")).toBe("B content");
  });

  it("warns on ambiguous bare-ID lookup instead of silently failing", () => {
    const registry = new UIRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    registry.addView({
      id: "shared",
      pluginId: "plugin-a",
      name: "A Shared",
      icon: "A",
      slot: "tools",
      contentType: "text",
      getContent: () => "A",
    });
    registry.addView({
      id: "shared",
      pluginId: "plugin-b",
      name: "B Shared",
      icon: "B",
      slot: "tools",
      contentType: "text",
      getContent: () => "B",
    });

    expect(registry.getViewContent("shared")).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

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
    expect(registry.getViewContent("test-plugin:text-view")).toBe("hello text");
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
    expect(registry.getViewContent("test-plugin:react-view")).toBeUndefined();
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
