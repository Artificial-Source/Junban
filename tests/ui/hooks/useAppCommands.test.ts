import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("../../../src/ui/themes/manager.js", () => ({
  themeManager: {
    toggle: vi.fn(),
    setTheme: vi.fn(),
  },
}));

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: {
      feature_completed: "false",
    },
  }),
}));

import { useAppCommands } from "../../../src/ui/hooks/useAppCommands.js";

describe("useAppCommands", () => {
  const handleNavigate = vi.fn();
  const openSettingsTab = vi.fn();
  const setFocusModeOpen = vi.fn();
  const setTemplateSelectorOpen = vi.fn();
  const executeCommand = vi.fn();

  function renderCommands(
    projects: { id: string; name: string }[] = [],
    pluginCommands: { id: string; name: string }[] = [],
    setQuickAddOpen?: any,
  ) {
    return renderHook(() =>
      useAppCommands(
        handleNavigate,
        openSettingsTab,
        setFocusModeOpen,
        setTemplateSelectorOpen,
        projects as any[],
        pluginCommands,
        executeCommand,
        setQuickAddOpen,
      ),
    );
  }

  it("returns an array of commands", () => {
    const { result } = renderCommands();
    expect(Array.isArray(result.current)).toBe(true);
    expect(result.current.length).toBeGreaterThan(0);
  });

  it("each command has id, name, and callback", () => {
    const { result } = renderCommands();
    for (const cmd of result.current) {
      expect(cmd).toHaveProperty("id");
      expect(cmd).toHaveProperty("name");
      expect(cmd).toHaveProperty("callback");
      expect(typeof cmd.callback).toBe("function");
    }
  });

  it("includes navigation commands", () => {
    const { result } = renderCommands();
    const ids = result.current.map((c) => c.id);
    expect(ids).toContain("nav-inbox");
    expect(ids).toContain("nav-today");
    expect(ids).toContain("nav-upcoming");
    expect(ids).toContain("nav-settings-filters");
    expect(ids).not.toContain("nav-completed");
  });

  it("navigation command calls handleNavigate", () => {
    const { result } = renderCommands();
    const todayCmd = result.current.find((c) => c.id === "nav-today")!;
    todayCmd.callback();
    expect(handleNavigate).toHaveBeenCalledWith("today");
  });

  it("includes theme toggle command", () => {
    const { result } = renderCommands();
    const toggle = result.current.find((c) => c.id === "theme-toggle");
    expect(toggle).toBeDefined();
    expect(toggle!.name).toBe("Toggle Dark Mode");
  });

  it("includes settings commands", () => {
    const { result } = renderCommands();
    const settingsCmd = result.current.find((c) => c.id === "nav-settings");
    expect(settingsCmd).toBeDefined();

    settingsCmd!.callback();
    expect(openSettingsTab).toHaveBeenCalledWith("general");
  });

  it("includes project navigation commands", () => {
    const projects = [
      { id: "p1", name: "Work" },
      { id: "p2", name: "Personal" },
    ];
    const { result } = renderCommands(projects);

    const workCmd = result.current.find((c) => c.id === "nav-project-p1");
    expect(workCmd).toBeDefined();
    expect(workCmd!.name).toBe("Go to Project: Work");

    workCmd!.callback();
    expect(handleNavigate).toHaveBeenCalledWith("project", "p1");
  });

  it("includes plugin commands", () => {
    const pluginCommands = [{ id: "timer-start", name: "Start Timer" }];
    const { result } = renderCommands([], pluginCommands);

    const pluginCmd = result.current.find((c) => c.id === "plugin-timer-start");
    expect(pluginCmd).toBeDefined();
    expect(pluginCmd!.name).toBe("Start Timer");

    pluginCmd!.callback();
    expect(executeCommand).toHaveBeenCalledWith("timer-start");
  });

  it("includes focus mode command", () => {
    const { result } = renderCommands();
    const focusCmd = result.current.find((c) => c.id === "focus-mode");
    expect(focusCmd).toBeDefined();

    focusCmd!.callback();
    expect(setFocusModeOpen).toHaveBeenCalledWith(true);
  });

  it("includes quick-add-task when setQuickAddOpen is provided", () => {
    const setQuickAddOpen = vi.fn();
    const { result } = renderCommands([], [], setQuickAddOpen);

    const quickAddCmd = result.current.find((c) => c.id === "quick-add-task");
    expect(quickAddCmd).toBeDefined();

    quickAddCmd!.callback();
    expect(setQuickAddOpen).toHaveBeenCalledWith(true);
  });

  it("omits quick-add-task when setQuickAddOpen is not provided", () => {
    const { result } = renderCommands();
    const quickAddCmd = result.current.find((c) => c.id === "quick-add-task");
    expect(quickAddCmd).toBeUndefined();
  });
});
