import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the API
vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getPluginViewContent: vi.fn().mockResolvedValue("text content"),
    executePluginCommand: vi.fn(),
  },
}));

import { PluginView, PluginErrorBoundary } from "../../../src/ui/views/PluginView.js";
import type { ViewInfo } from "../../../src/ui/api/plugins.js";

describe("PluginView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render text content by default", async () => {
    render(<PluginView viewId="test-view" />);
    // Text view fetches content asynchronously
    expect(await screen.findByText("text content")).toBeDefined();
  });

  it("should render React component when contentType is react", () => {
    const TestComponent = () => <div>React Plugin Content</div>;
    const viewInfo: ViewInfo = {
      id: "react-view",
      name: "React View",
      icon: "⚛️",
      slot: "tools",
      contentType: "react",
      pluginId: "test-plugin",
      component: TestComponent,
    };

    render(<PluginView viewId="react-view" viewInfo={viewInfo} />);
    expect(screen.getByText("React Plugin Content")).toBeDefined();
  });

  it("should wrap React component in ErrorBoundary", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const CrashingComponent = () => {
      throw new Error("Plugin crashed!");
    };
    const viewInfo: ViewInfo = {
      id: "crash-view",
      name: "Crashy",
      icon: "💥",
      slot: "tools",
      contentType: "react",
      pluginId: "crashy-plugin",
      component: CrashingComponent,
    };

    render(<PluginView viewId="crash-view" viewInfo={viewInfo} />);
    expect(screen.getByText("Plugin Error")).toBeDefined();
    expect(screen.getByText(/crashy-plugin/)).toBeDefined();
    expect(screen.getByText("Plugin crashed!")).toBeDefined();

    errorSpy.mockRestore();
  });
});

describe("PluginErrorBoundary", () => {
  it("should render children when no error", () => {
    render(
      <PluginErrorBoundary pluginId="test">
        <div>Safe Content</div>
      </PluginErrorBoundary>,
    );
    expect(screen.getByText("Safe Content")).toBeDefined();
  });

  it("should catch and display error from child", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const Bomb = () => {
      throw new Error("boom");
    };

    render(
      <PluginErrorBoundary pluginId="bomb-plugin">
        <Bomb />
      </PluginErrorBoundary>,
    );

    expect(screen.getByText("Plugin Error")).toBeDefined();
    expect(screen.getByText(/bomb-plugin/)).toBeDefined();
    expect(screen.getByText("boom")).toBeDefined();

    errorSpy.mockRestore();
  });
});
