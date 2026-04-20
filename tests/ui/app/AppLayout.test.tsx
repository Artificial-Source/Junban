import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { AppLayout } from "../../../src/ui/app/AppLayout.js";
import type { AppState } from "../../../src/ui/context/AppStateContext.js";

vi.mock("../../../src/ui/components/Sidebar.js", () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

vi.mock("../../../src/ui/app/ViewRenderer.js", () => ({
  ViewRenderer: () => <div>View content</div>,
}));

function createProps(overrides: Partial<ComponentProps<typeof AppLayout>> = {}) {
  return {
    currentView: "inbox" as const,
    selectedProjectId: null,
    selectedRouteTaskId: null,
    selectedPluginViewId: null,
    selectedFilterId: null,
    tasks: [],
    projects: [],
    availableTags: [],
    loading: false,
    error: null,
    sidebarCollapsed: false,
    onToggleSidebar: vi.fn(),
    panels: [],
    pluginViews: [],
    builtinPluginIds: new Set<string>(),
    savedFilters: [],
    projectTaskCounts: new Map<string, number>(),
    projectCompletedCounts: new Map<string, number>(),
    inboxTaskCount: 0,
    todayTaskCount: 0,
    isMobile: false,
    drawerOpen: false,
    setDrawerOpen: vi.fn(),
    multiSelectedIds: new Set<string>(),
    handleBulkComplete: vi.fn(),
    handleBulkDelete: vi.fn(),
    handleBulkMoveToProject: vi.fn(),
    handleBulkAddTag: vi.fn(),
    clearSelection: vi.fn(),
    selectedTask: null,
    selectedTaskIdx: -1,
    selectedTaskProjectName: "Inbox",
    visibleTasks: [],
    taskComments: [],
    taskActivity: [],
    handleNavigate: vi.fn(),
    handleOpenSettings: vi.fn(),
    handleAddTask: vi.fn(),
    handleOpenVoice: vi.fn(),
    handleCreateProject: vi.fn(),
    handleUpdateProject: vi.fn(),
    handleDeleteProject: vi.fn(),
    handleCreateTask: vi.fn(),
    handleToggleTask: vi.fn(),
    handleSelectTask: vi.fn(),
    handleUpdateTask: vi.fn(),
    handleDeleteTask: vi.fn(),
    handleMultiSelect: vi.fn(),
    handleReorder: vi.fn(),
    handleAddSubtask: vi.fn(),
    handleUpdateDueDate: vi.fn(),
    handleContextMenu: vi.fn(),
    handleCreateSection: vi.fn(),
    handleUpdateSection: vi.fn(),
    handleDeleteSection: vi.fn(),
    handleMoveTask: vi.fn(),
    handleCloseDetail: vi.fn(),
    handleIndent: vi.fn(),
    handleOutdent: vi.fn(),
    handleAddComment: vi.fn(),
    handleUpdateComment: vi.fn(),
    handleDeleteComment: vi.fn(),
    addTaskTrigger: 0,
    handleOpenSettingsTab: vi.fn(),
    setSearchOpen: vi.fn(),
    setProjectModalOpen: vi.fn(),
    appState: {
      currentView: "inbox",
      projects: [],
      selectedProjectId: null,
      selectedRouteTaskId: null,
      selectedPluginViewId: null,
      selectedFilterId: null,
      selectedTaskId: null,
      multiSelectedIds: new Set<string>(),
      featureSettings: {} as AppState["featureSettings"],
      pluginViews: [],
      sections: [],
      availableTags: [],
      tasks: [],
    } as AppState,
    remoteServerRunning: false,
    mutationsBlocked: false,
    handleStopRemoteServer: vi.fn(),
    ...overrides,
  };
}

describe("AppLayout remote access lock", () => {
  it("moves focus to the stop control and marks the workspace unavailable", async () => {
    const { rerender } = render(<AppLayout {...createProps()} />);

    rerender(<AppLayout {...createProps({ remoteServerRunning: true, mutationsBlocked: true })} />);

    const stopButton = await screen.findByRole("button", { name: "Stop remote access" });
    await waitFor(() => {
      expect(stopButton).toHaveFocus();
    });

    expect(screen.getByRole("region", { name: /remote session active/i })).toBeInTheDocument();

    const workspace = screen.getByTestId("app-workspace");
    expect(workspace).toHaveAttribute("aria-disabled", "true");
    expect(workspace).toHaveAttribute("inert");
  });
});
