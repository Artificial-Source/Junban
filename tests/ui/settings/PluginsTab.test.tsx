import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Puzzle: (props: any) => <svg data-testid="puzzle-icon" {...props} />,
  Search: (props: any) => <svg data-testid="search-icon" {...props} />,
  ShieldCheck: (props: any) => <svg data-testid="shield-check-icon" {...props} />,
  ShieldAlert: (props: any) => <svg data-testid="shield-alert-icon" {...props} />,
}));

const mockRefreshPlugins = vi.fn().mockResolvedValue(undefined);
const mockRefreshViews = vi.fn().mockResolvedValue(undefined);
const mockRefreshPanels = vi.fn().mockResolvedValue(undefined);
const mockRefreshStatusBar = vi.fn().mockResolvedValue(undefined);
const mockRefreshCommands = vi.fn().mockResolvedValue(undefined);
const mockTogglePlugin = vi.fn().mockResolvedValue(undefined);
const mockApprovePluginPermissions = vi.fn().mockResolvedValue(undefined);
const mockRevokePluginPermissions = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../src/ui/context/PluginContext.js", () => ({
  usePluginContext: () => ({
    plugins: [
      {
        id: "pomodoro",
        name: "Pomodoro Timer",
        description: "Focus timer",
        author: "ASF",
        version: "1.0.0",
        enabled: true,
        builtin: true,
        permissions: [],
        settings: [],
      },
      {
        id: "community-plugin",
        name: "Community Plugin",
        description: "A community plugin",
        author: "User",
        version: "0.1.0",
        enabled: false,
        builtin: false,
        permissions: ["tasks:read"],
        settings: [],
      },
    ],
    refreshPlugins: (...args: any[]) => mockRefreshPlugins(...args),
    refreshViews: (...args: any[]) => mockRefreshViews(...args),
    refreshPanels: (...args: any[]) => mockRefreshPanels(...args),
    refreshStatusBar: (...args: any[]) => mockRefreshStatusBar(...args),
    refreshCommands: (...args: any[]) => mockRefreshCommands(...args),
  }),
}));

vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    togglePlugin: (...args: any[]) => mockTogglePlugin(...args),
    approvePluginPermissions: (...args: any[]) => mockApprovePluginPermissions(...args),
    revokePluginPermissions: (...args: any[]) => mockRevokePluginPermissions(...args),
  },
}));

vi.mock("../../../src/ui/components/PluginCard.js", () => ({
  PluginCard: ({ plugin, onToggle, onRevoke, onRequestApproval }: any) => (
    <div data-testid={`plugin-card-${plugin.id}`}>
      <span>{plugin.name}</span>
      {onToggle && (
        <button data-testid={`toggle-${plugin.id}`} onClick={onToggle}>
          Toggle
        </button>
      )}
      {onRequestApproval && (
        <button data-testid={`approve-${plugin.id}`} onClick={onRequestApproval}>
          Approve
        </button>
      )}
      {onRevoke && (
        <button data-testid={`revoke-${plugin.id}`} onClick={onRevoke}>
          Revoke
        </button>
      )}
    </div>
  ),
}));

vi.mock("../../../src/ui/components/PluginBrowser.js", () => ({
  PluginBrowser: ({ open }: any) => (open ? <div data-testid="plugin-browser">Browser</div> : null),
}));

vi.mock("../../../src/ui/components/PermissionDialog.js", () => ({
  PermissionDialog: ({ onApprove }: any) => (
    <div data-testid="permission-dialog">
      Permission Dialog
      <button data-testid="permission-approve" onClick={() => onApprove(["tasks:read"])}>
        Confirm Approve
      </button>
    </div>
  ),
}));

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { community_plugins_enabled: "false" },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

vi.mock("../../../src/ui/views/settings/components.js", () => ({
  Toggle: ({ enabled, onToggle }: any) => (
    <button data-testid="toggle-component" onClick={onToggle}>
      {enabled ? "on" : "off"}
    </button>
  ),
}));

import { PluginsTab } from "../../../src/ui/views/settings/PluginsTab.js";

describe("PluginsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders built-in plugins section", () => {
    render(<PluginsTab />);
    expect(screen.getByText("Built-in Extensions")).toBeDefined();
    expect(screen.getByText("Pomodoro Timer")).toBeDefined();
  });

  it("renders community plugins section", () => {
    render(<PluginsTab />);
    expect(screen.getByText("Community Plugins")).toBeDefined();
    expect(screen.getByText("Community Plugin")).toBeDefined();
  });

  it("renders search input", () => {
    render(<PluginsTab />);
    expect(screen.getByPlaceholderText("Search plugins...")).toBeDefined();
  });

  it("filters plugins by search query", () => {
    render(<PluginsTab />);
    const searchInput = screen.getByPlaceholderText("Search plugins...");
    fireEvent.change(searchInput, { target: { value: "Pomodoro" } });
    expect(screen.getByText("Pomodoro Timer")).toBeDefined();
    expect(screen.queryByText("Community Plugin")).toBeNull();
  });

  it("shows no results message for non-matching search", () => {
    render(<PluginsTab />);
    const searchInput = screen.getByPlaceholderText("Search plugins...");
    fireEvent.change(searchInput, { target: { value: "xyznonexistent" } });
    expect(screen.getByText("No plugins match your search.")).toBeDefined();
  });

  it("renders browse community plugins button", () => {
    render(<PluginsTab />);
    expect(screen.getByText("Browse Community Plugins")).toBeDefined();
  });

  it("opens plugin browser on button click", async () => {
    render(<PluginsTab />);
    fireEvent.click(screen.getByText("Browse Community Plugins"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-browser")).toBeDefined();
    });
  });

  it("calls toggle on built-in plugin", async () => {
    render(<PluginsTab />);
    fireEvent.click(screen.getByTestId("toggle-pomodoro"));
    await waitFor(() => {
      expect(mockTogglePlugin).toHaveBeenCalledWith("pomodoro");
    });
  });

  it("shows an error message when toggle fails", async () => {
    mockTogglePlugin.mockRejectedValueOnce(new Error("toggle failed"));

    render(<PluginsTab />);
    fireEvent.click(screen.getByTestId("toggle-pomodoro"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("toggle failed");
    });
  });

  it("shows an error message when revoke fails", async () => {
    mockRevokePluginPermissions.mockRejectedValueOnce(new Error("revoke failed"));

    render(<PluginsTab />);
    fireEvent.click(screen.getByTestId("revoke-community-plugin"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("revoke failed");
    });
  });

  it("shows an error message when approval fails", async () => {
    mockApprovePluginPermissions.mockRejectedValueOnce(new Error("approve failed"));

    render(<PluginsTab />);
    fireEvent.click(screen.getByTestId("approve-community-plugin"));

    await waitFor(() => {
      expect(screen.getByTestId("permission-dialog")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("permission-approve"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("approve failed");
    });
  });
});
