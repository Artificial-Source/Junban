/**
 * @vitest-environment jsdom
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsResponse } from "../../api/client";
import type { SettingsTabId } from "../../hooks/useRouting";
import { SettingsDialog } from "./SettingsDialog";

const SETTINGS_TAB_LABELS = [
  "Essentials",
  "Appearance",
  "Features",
  "AI",
  "Voice",
  "Keyboard",
  "Templates",
  "Data",
  "Hosted",
  "Diagnostics",
];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveSettings = vi.fn();
const refreshSettings = vi.fn();
const refreshCatalog = vi.fn();

const baseSettings: AppSettingsResponse = {
  appearance: {
    theme: "light",
    accent: "#3b82f6",
    density: "comfortable",
    font_size: "medium",
    font_family: "outfit",
    reduced_motion: false,
  },
  date_time: {
    week_start: "sunday",
    calendar_default: "week",
    date_format: "short",
    time_format: "h24",
  },
  task_defaults: {
    default_priority: null,
    default_view: "today",
    default_estimated_minutes: null,
    confirm_before_delete: true,
  },
  notifications: {
    channels: ["in_app"],
    sound_enabled: true,
    volume_percent: 70,
    task_completed_sound: true,
    task_created_sound: true,
    task_deleted_sound: true,
    reminder_sound: true,
  },
  features: {
    nudges_enabled: true,
    eat_the_frog_enabled: false,
    task_jar_enabled: false,
    focus_mode_enabled: false,
    daily_planning_enabled: true,
    weekly_review_enabled: true,
  },
  planning: {
    capacity_minutes: 480,
    work_hours: null,
    nudge_rules: [
      { kind: "overdue", enabled: true, threshold: null },
      { kind: "approaching_deadline", enabled: true, threshold: null },
      { kind: "stale_task", enabled: true, threshold: 14 },
      { kind: "empty_today", enabled: true, threshold: null },
      { kind: "overloaded_day", enabled: true, threshold: null },
    ],
  },
  keyboard_shortcuts: [
    { action: "quick-add", chord: "cmd+a" },
    { action: "search", chord: "cmd+k" },
  ],
};

vi.mock("../../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    settings: baseSettings,
    settingsLoading: false,
    settingsError: null,
    refreshSettings,
    saveSettings,
    catalog: {
      templates: [],
      tags: [],
      projects: [],
      sections: [],
      saved_filters: [],
      revision: 1,
    },
    catalogLoading: false,
    catalogError: null,
    refreshCatalog,
    runMutation: vi.fn(),
    showToast: vi.fn(),
  }),
}));

vi.mock("../../hooks/useIsMobile", () => ({
  useIsMobile: () => mockIsMobile,
}));

let mockIsMobile = false;

function Harness({
  initialTab = "essentials",
  onClose = () => undefined,
}: {
  initialTab?: SettingsTabId | null;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<SettingsTabId | null>(initialTab);
  return createElement(SettingsDialog, {
    tab,
    onNavigateTab: setTab,
    onClose,
  });
}

describe("SettingsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockIsMobile = false;
    saveSettings.mockReset().mockResolvedValue({ event: { operation_id: "op" } });
    refreshSettings.mockReset();
    refreshCatalog.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders desktop tab rail including AI and Voice without other legacy tabs", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const nav = container.querySelector('nav[aria-label="Settings tabs"]');
    expect(nav).toBeTruthy();
    const labels = Array.from(nav!.querySelectorAll("button")).map((btn) =>
      btn.textContent?.trim(),
    );
    expect(labels).toEqual(SETTINGS_TAB_LABELS);
    expect(labels).toContain("AI");
    expect(labels).toContain("Voice");
    expect(labels).not.toContain("Extensions");
    expect(labels).not.toContain("About");
  });

  it("closes from the header control and backdrop", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(createElement(Harness, { onClose }));
    });
    const close = container.querySelector(
      'button[aria-label="Close settings"]',
    ) as HTMLButtonElement;
    act(() => {
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    const backdrop = container.querySelector('[data-testid="settings-backdrop"]') as HTMLElement;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close Settings when Escape is owned by a nested confirm dialog", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(createElement(Harness, { onClose }));
    });
    const surface = container.querySelector('[data-testid="settings-surface"]') as HTMLElement;
    const nested = document.createElement("div");
    nested.setAttribute("role", "alertdialog");
    nested.setAttribute("aria-modal", "true");
    surface.append(nested);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    nested.remove();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mobile index opens a detail tab and returns with back", () => {
    mockIsMobile = true;
    act(() => {
      root.render(createElement(Harness, { initialTab: null }));
    });
    expect(container.querySelector("h2")?.textContent).toBe("Settings");
    const appearance = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Appearance"),
    ) as HTMLButtonElement;
    act(() => {
      appearance.click();
    });
    expect(container.querySelector("h2")?.textContent).toBe("Appearance");
    const back = container.querySelector(
      'button[aria-label="Back to settings"]',
    ) as HTMLButtonElement;
    act(() => {
      back.click();
    });
    expect(container.querySelector("h2")?.textContent).toBe("Settings");
  });

  it("saves appearance only through confirmed settings patches", () => {
    act(() => {
      root.render(createElement(Harness, { initialTab: "appearance" }));
    });
    const dark = Array.from(container.querySelectorAll('input[type="radio"]')).find(
      (input) => (input as HTMLInputElement).value === "dark",
    ) as HTMLInputElement;
    act(() => {
      dark.click();
    });
    expect(saveSettings).toHaveBeenCalledWith({
      appearance: expect.objectContaining({ theme: "dark" }),
    });
  });

  it("saves sound effect settings without reminder_defaults", async () => {
    await act(async () => {
      root.render(createElement(Harness, { initialTab: "features" }));
    });
    expect(container.textContent).toContain("Sound Effects");
    expect(container.querySelector("#settings-sound-volume")).toBeTruthy();

    const masterLabel = Array.from(container.querySelectorAll("label")).find(
      (label) => label.textContent?.trim() === "Enable sound effects",
    ) as HTMLLabelElement;
    const master = masterLabel?.htmlFor
      ? (container.querySelector(`#${CSS.escape(masterLabel.htmlFor)}`) as HTMLInputElement)
      : null;
    expect(master).toBeTruthy();
    await act(async () => {
      master!.click();
    });
    expect(saveSettings).toHaveBeenCalledWith({
      notifications: expect.objectContaining({
        sound_enabled: false,
        volume_percent: 70,
        task_completed_sound: true,
        task_created_sound: true,
        task_deleted_sound: true,
        reminder_sound: true,
      }),
    });
    const payload = saveSettings.mock.calls.at(-1)?.[0] as {
      notifications?: Record<string, unknown>;
    };
    expect(payload.notifications).not.toHaveProperty("reminder_defaults");

    saveSettings.mockClear();
    const completedToggle = Array.from(container.querySelectorAll('input[type="checkbox"]')).find(
      (input) => input.getAttribute("aria-label") === "Task completed",
    ) as HTMLInputElement;
    expect(completedToggle).toBeTruthy();
    await act(async () => {
      completedToggle.click();
    });
    expect(saveSettings).toHaveBeenCalledWith({
      notifications: expect.objectContaining({
        task_completed_sound: false,
        volume_percent: 70,
        sound_enabled: true,
      }),
    });
  });
});
