import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { start_view: "inbox" },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

import { useRouting } from "../../../src/ui/hooks/useRouting.js";

describe("useRouting", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("defaults to inbox view", () => {
    const { result } = renderHook(() => useRouting());
    expect(result.current.currentView).toBe("inbox");
  });

  it("navigate to today", () => {
    const { result } = renderHook(() => useRouting());
    act(() => {
      result.current.handleNavigate("today");
    });
    expect(result.current.currentView).toBe("today");
  });

  it("navigate to project with id", () => {
    const { result } = renderHook(() => useRouting());
    act(() => {
      result.current.handleNavigate("project", "proj-1");
    });
    expect(result.current.currentView).toBe("project");
    expect(result.current.selectedProjectId).toBe("proj-1");
  });

  it("navigate to task with id", () => {
    const { result } = renderHook(() => useRouting());
    act(() => {
      result.current.handleNavigate("task", "task-42");
    });
    expect(result.current.currentView).toBe("task");
    expect(result.current.selectedRouteTaskId).toBe("task-42");
  });

  it("navigate to plugin-view with id", () => {
    const { result } = renderHook(() => useRouting());
    act(() => {
      result.current.handleNavigate("plugin-view", "pomodoro");
    });
    expect(result.current.currentView).toBe("plugin-view");
    expect(result.current.selectedPluginViewId).toBe("pomodoro");
  });

  it("clears projectId when navigating away from project view", () => {
    const { result } = renderHook(() => useRouting());
    act(() => {
      result.current.handleNavigate("project", "proj-1");
    });
    expect(result.current.selectedProjectId).toBe("proj-1");

    act(() => {
      result.current.handleNavigate("inbox");
    });
    expect(result.current.selectedProjectId).toBeNull();
  });

  it("setFocusModeOpen toggles focus mode", () => {
    const { result } = renderHook(() => useRouting());
    expect(result.current.focusModeOpen).toBe(false);
    act(() => {
      result.current.setFocusModeOpen(true);
    });
    expect(result.current.focusModeOpen).toBe(true);
  });

  it("navigate to calendar resolves to the built-in plugin view", () => {
    const { result } = renderHook(() => useRouting());
    act(() => {
      result.current.handleNavigate("calendar");
    });
    expect(result.current.currentView).toBe("plugin-view");
    expect(result.current.selectedPluginViewId).toBeTruthy();
    expect(window.location.hash).toContain("#/plugin-view/");
  });

  it("openSettingsTab updates settingsTab", () => {
    const { result } = renderHook(() => useRouting());
    act(() => {
      result.current.openSettingsTab("appearance");
    });
    expect(result.current.settingsTab).toBe("appearance");
  });

  it("parses hash with project route on mount", () => {
    window.location.hash = "#/project/my-project";
    const { result } = renderHook(() => useRouting());
    expect(result.current.currentView).toBe("project");
    expect(result.current.selectedProjectId).toBe("my-project");
  });

  it("parses legacy calendar hash into the built-in plugin view", () => {
    window.location.hash = "#/calendar?mode=month";
    const { result } = renderHook(() => useRouting());
    expect(result.current.currentView).toBe("plugin-view");
    expect(result.current.selectedPluginViewId).toBeTruthy();
  });

  it("parses focus=1 query param from hash", () => {
    window.location.hash = "#/today?focus=1";
    const { result } = renderHook(() => useRouting());
    expect(result.current.currentView).toBe("today");
    expect(result.current.focusModeOpen).toBe(true);
  });

  it("settings hash redirects to inbox", () => {
    window.location.hash = "#/settings";
    const { result } = renderHook(() => useRouting());
    expect(result.current.currentView).toBe("inbox");
  });
});
