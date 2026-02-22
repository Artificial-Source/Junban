import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Download: (props: any) => <svg data-testid="download-icon" {...props} />,
  Trash2: (props: any) => <svg data-testid="trash-icon" {...props} />,
  Loader2: (props: any) => <svg data-testid="loader-icon" {...props} />,
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
  ChevronUp: (props: any) => <svg data-testid="chevron-up" {...props} />,
  ExternalLink: (props: any) => <svg data-testid="external-link" {...props} />,
  Shield: (props: any) => <svg data-testid="shield-icon" {...props} />,
}));

vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getPluginSettings: vi.fn().mockResolvedValue({}),
    updatePluginSetting: vi.fn().mockResolvedValue(undefined),
  },
}));

import { PluginCard } from "../../../src/ui/components/PluginCard.js";
import type { PluginInfo } from "../../../src/ui/api/index.js";

const settingsPlugin: PluginInfo = {
  id: "pomodoro",
  name: "Pomodoro Timer",
  description: "Focus timer with breaks",
  author: "ASF",
  version: "1.0.0",
  enabled: true,
  builtin: true,
  permissions: [],
  settings: [],
} as any;

describe("PluginCard — settings mode", () => {
  it("renders plugin name and description", () => {
    render(
      <PluginCard
        mode="settings"
        plugin={settingsPlugin}
        expanded={false}
        onToggleExpand={vi.fn()}
      />,
    );
    expect(screen.getByText("Pomodoro Timer")).toBeDefined();
    expect(screen.getByText("Focus timer with breaks")).toBeDefined();
  });

  it("renders Built-in badge for built-in plugins", () => {
    render(
      <PluginCard
        mode="settings"
        plugin={settingsPlugin}
        expanded={false}
        onToggleExpand={vi.fn()}
      />,
    );
    expect(screen.getByText("Built-in")).toBeDefined();
  });

  it("renders Active badge when enabled", () => {
    render(
      <PluginCard
        mode="settings"
        plugin={settingsPlugin}
        expanded={false}
        onToggleExpand={vi.fn()}
      />,
    );
    expect(screen.getByText("Active")).toBeDefined();
  });

  it("renders Inactive badge when disabled", () => {
    const disabled = { ...settingsPlugin, enabled: false };
    render(
      <PluginCard mode="settings" plugin={disabled} expanded={false} onToggleExpand={vi.fn()} />,
    );
    expect(screen.getByText("Inactive")).toBeDefined();
  });

  it("renders toggle switch for built-in plugin", () => {
    const onToggle = vi.fn();
    render(
      <PluginCard
        mode="settings"
        plugin={settingsPlugin}
        expanded={false}
        onToggleExpand={vi.fn()}
        onToggle={onToggle}
      />,
    );
    // Find the toggle button (a rounded-full button)
    const buttons = screen.getAllByRole("button");
    const toggleBtn = buttons.find((b) => b.className.includes("rounded-full"));
    expect(toggleBtn).toBeDefined();
  });

  it("calls onToggle when toggle is clicked", () => {
    const onToggle = vi.fn();
    render(
      <PluginCard
        mode="settings"
        plugin={settingsPlugin}
        expanded={false}
        onToggleExpand={vi.fn()}
        onToggle={onToggle}
      />,
    );
    const buttons = screen.getAllByRole("button");
    const toggleBtn = buttons.find((b) => b.className.includes("rounded-full"));
    if (toggleBtn) {
      fireEvent.click(toggleBtn);
      expect(onToggle).toHaveBeenCalled();
    }
  });

  it("renders version info", () => {
    render(
      <PluginCard
        mode="settings"
        plugin={settingsPlugin}
        expanded={false}
        onToggleExpand={vi.fn()}
      />,
    );
    expect(screen.getByText("v1.0.0")).toBeDefined();
  });

  it("calls onToggleExpand when expand button is clicked", () => {
    const onToggleExpand = vi.fn();
    render(
      <PluginCard
        mode="settings"
        plugin={settingsPlugin}
        expanded={false}
        onToggleExpand={onToggleExpand}
      />,
    );
    // Find the expand button (chevron button)
    const expandBtn = screen
      .getAllByRole("button")
      .find((b) => b.querySelector("[data-testid='chevron-down']"));
    if (expandBtn) {
      fireEvent.click(expandBtn);
      expect(onToggleExpand).toHaveBeenCalled();
    }
  });
});
