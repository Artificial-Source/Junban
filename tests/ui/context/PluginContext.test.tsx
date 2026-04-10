import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

const pluginApiMocks = vi.hoisted(() => ({
  listPlugins: vi.fn().mockResolvedValue([]),
  listPluginCommands: vi.fn().mockResolvedValue([]),
  getStatusBarItems: vi.fn().mockResolvedValue([]),
  getPluginPanels: vi.fn().mockResolvedValue([]),
  getPluginViews: vi.fn().mockResolvedValue([]),
  executePluginCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/ui/api/plugins.js", () => pluginApiMocks);
import { PluginProvider, usePluginContext } from "../../../src/ui/context/PluginContext.js";

function TestConsumer() {
  const { plugins, commands, statusBarItems, panels, views, executeCommand, refreshPlugins } =
    usePluginContext();
  return (
    <div>
      <span data-testid="plugins">{JSON.stringify(plugins)}</span>
      <span data-testid="commands">{JSON.stringify(commands)}</span>
      <span data-testid="status-bar">{JSON.stringify(statusBarItems)}</span>
      <span data-testid="panels">{JSON.stringify(panels)}</span>
      <span data-testid="views">{JSON.stringify(views)}</span>
      <span data-testid="plugin-count">{plugins.length}</span>
      <span data-testid="command-count">{commands.length}</span>
      <button data-testid="execute" onClick={() => executeCommand("cmd-1")}>
        Execute
      </button>
      <button data-testid="refresh" onClick={() => refreshPlugins()}>
        Refresh
      </button>
    </div>
  );
}

describe("PluginContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Reset mock implementations to defaults after each test
    pluginApiMocks.listPlugins.mockResolvedValue([]);
    pluginApiMocks.listPluginCommands.mockResolvedValue([]);
    pluginApiMocks.getStatusBarItems.mockResolvedValue([]);
    pluginApiMocks.getPluginPanels.mockResolvedValue([]);
    pluginApiMocks.getPluginViews.mockResolvedValue([]);
    pluginApiMocks.executePluginCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      "usePluginContext must be used within PluginProvider",
    );
    spy.mockRestore();
  });

  it("fetches plugins, commands, status bar, panels, and views on mount", async () => {
    const mockPlugins = [
      {
        id: "p1",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test",
        description: "A test plugin",
        enabled: true,
        permissions: [],
        settings: [],
        builtin: false,
      },
    ];
    const mockCommands = [{ id: "cmd-1", name: "Test Command", hotkey: "Ctrl+T" }];
    const mockStatusBar = [{ id: "sb-1", text: "Active", icon: "circle" }];
    const mockPanels = [{ id: "panel-1", title: "Panel", icon: "box", content: "<p>Hello</p>" }];
    const mockViews = [
      {
        id: "view-1",
        name: "Custom View",
        icon: "eye",
        slot: "navigation" as const,
        contentType: "text" as const,
        pluginId: "p1",
      },
    ];

    pluginApiMocks.listPlugins.mockResolvedValue(mockPlugins);
    pluginApiMocks.listPluginCommands.mockResolvedValue(mockCommands);
    pluginApiMocks.getStatusBarItems.mockResolvedValue(mockStatusBar);
    pluginApiMocks.getPluginPanels.mockResolvedValue(mockPanels);
    pluginApiMocks.getPluginViews.mockResolvedValue(mockViews);

    render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(screen.getByTestId("plugin-count").textContent).toBe("1");
    });

    expect(pluginApiMocks.listPlugins).toHaveBeenCalled();
    expect(pluginApiMocks.listPluginCommands).toHaveBeenCalled();
    expect(pluginApiMocks.getStatusBarItems).toHaveBeenCalled();
    expect(pluginApiMocks.getPluginPanels).toHaveBeenCalled();
    expect(pluginApiMocks.getPluginViews).toHaveBeenCalled();

    const plugins = JSON.parse(screen.getByTestId("plugins").textContent!);
    expect(plugins[0].name).toBe("Test Plugin");

    const commands = JSON.parse(screen.getByTestId("commands").textContent!);
    expect(commands[0].name).toBe("Test Command");

    const statusBar = JSON.parse(screen.getByTestId("status-bar").textContent!);
    expect(statusBar[0].text).toBe("Active");

    const panels = JSON.parse(screen.getByTestId("panels").textContent!);
    expect(panels[0].title).toBe("Panel");

    const views = JSON.parse(screen.getByTestId("views").textContent!);
    expect(views[0].name).toBe("Custom View");
  });

  it("provides empty arrays when api returns empty results", async () => {
    render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    await waitFor(() => {
      expect(pluginApiMocks.listPlugins).toHaveBeenCalled();
    });

    expect(screen.getByTestId("plugin-count").textContent).toBe("0");
    expect(screen.getByTestId("command-count").textContent).toBe("0");
  });

  it("executeCommand calls api and refreshes status bar and panels", async () => {
    render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    await waitFor(() => {
      expect(pluginApiMocks.listPlugins).toHaveBeenCalled();
    });

    // Clear mocks to track execute-specific calls
    vi.clearAllMocks();

    await act(async () => {
      screen.getByTestId("execute").click();
    });

    expect(pluginApiMocks.executePluginCommand).toHaveBeenCalledWith("cmd-1");
    expect(pluginApiMocks.getStatusBarItems).toHaveBeenCalled();
    expect(pluginApiMocks.getPluginPanels).toHaveBeenCalled();
  });

  it("polls status bar and panels every 30 seconds", async () => {
    render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    await waitFor(() => {
      expect(pluginApiMocks.listPlugins).toHaveBeenCalled();
    });

    const initialStatusBarCalls = pluginApiMocks.getStatusBarItems.mock.calls.length;
    const initialPanelCalls = pluginApiMocks.getPluginPanels.mock.calls.length;

    // Advance time by 30 seconds
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    await waitFor(() => {
      expect(pluginApiMocks.getStatusBarItems.mock.calls.length).toBeGreaterThan(
        initialStatusBarCalls,
      );
      expect(pluginApiMocks.getPluginPanels.mock.calls.length).toBeGreaterThan(initialPanelCalls);
    });

    // Advance another 30 seconds
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    await waitFor(() => {
      expect(pluginApiMocks.getStatusBarItems.mock.calls.length).toBeGreaterThan(
        initialStatusBarCalls + 1,
      );
    });
  });

  it("cleans up polling interval on unmount", async () => {
    const { unmount } = render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    await waitFor(() => {
      expect(pluginApiMocks.listPlugins).toHaveBeenCalled();
    });

    const callsBefore = pluginApiMocks.getStatusBarItems.mock.calls.length;

    unmount();

    // Advance time — polling should not fire
    act(() => {
      vi.advanceTimersByTime(60000);
    });

    expect(pluginApiMocks.getStatusBarItems.mock.calls.length).toBe(callsBefore);
  });

  it("mountedRef prevents stale updates after unmount", async () => {
    let resolvePlugins!: (value: any) => void;
    pluginApiMocks.listPlugins.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePlugins = resolve;
        }),
    );

    const { unmount } = render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    // Unmount before the fetch resolves
    unmount();

    // Resolving now should not cause any errors (mountedRef check prevents setState)
    await act(async () => {
      resolvePlugins([{ id: "p1", name: "Late plugin" }]);
    });

    // No error means the mountedRef guard worked
  });

  it("refreshPlugins reloads plugins from api", async () => {
    render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    await waitFor(() => {
      expect(pluginApiMocks.listPlugins).toHaveBeenCalled();
    });

    // Set up new data for refresh
    pluginApiMocks.listPlugins.mockResolvedValue([
      {
        id: "p2",
        name: "Refreshed Plugin",
        version: "2.0.0",
        author: "Test",
        description: "Refreshed",
        enabled: true,
        permissions: [],
        settings: [],
        builtin: false,
      },
    ]);

    await act(async () => {
      screen.getByTestId("refresh").click();
    });

    await waitFor(() => {
      const plugins = JSON.parse(screen.getByTestId("plugins").textContent!);
      expect(plugins[0].name).toBe("Refreshed Plugin");
    });
  });

  it("handles api errors gracefully on mount", async () => {
    pluginApiMocks.listPlugins.mockRejectedValue(new Error("Server error"));
    pluginApiMocks.listPluginCommands.mockRejectedValue(new Error("Server error"));
    pluginApiMocks.getStatusBarItems.mockRejectedValue(new Error("Server error"));
    pluginApiMocks.getPluginPanels.mockRejectedValue(new Error("Server error"));
    pluginApiMocks.getPluginViews.mockRejectedValue(new Error("Server error"));

    // Should not throw — errors are caught internally
    render(
      <PluginProvider>
        <TestConsumer />
      </PluginProvider>,
    );

    await waitFor(() => {
      expect(pluginApiMocks.listPlugins).toHaveBeenCalled();
    });

    // State should remain empty (defaults)
    expect(screen.getByTestId("plugin-count").textContent).toBe("0");
    expect(screen.getByTestId("command-count").textContent).toBe("0");
  });
});
