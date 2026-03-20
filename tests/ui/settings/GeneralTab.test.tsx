import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GeneralTab } from "../../../src/ui/views/settings/GeneralTab.js";
import { SettingsProvider } from "../../../src/ui/context/SettingsContext.js";

// Mock api
vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getAllSettings: vi.fn().mockResolvedValue({}),
    getAppSetting: vi.fn().mockResolvedValue(null),
    setAppSetting: vi.fn().mockResolvedValue(undefined),
  },
}));

import { api } from "../../../src/ui/api/index.js";

// Mock themeManager (still needed by SettingsProvider indirectly)
vi.mock("../../../src/ui/themes/manager.js", () => ({
  themeManager: {
    getCurrent: vi.fn().mockReturnValue("system"),
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue([
      { id: "light", name: "Light", type: "light" },
      { id: "dark", name: "Dark", type: "dark" },
    ]),
  },
}));

// Mock sounds utility
vi.mock("../../../src/utils/sounds.js", () => ({
  previewSound: vi.fn(),
}));

// Mock Notification API
const mockNotification = {
  permission: "default" as NotificationPermission,
  requestPermission: vi.fn().mockResolvedValue("granted"),
};
Object.defineProperty(window, "Notification", { value: mockNotification, writable: true });

function renderGeneralTab() {
  return render(
    <SettingsProvider>
      <GeneralTab />
    </SettingsProvider>,
  );
}

describe("GeneralTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getAppSetting as any).mockResolvedValue(null);
    document.documentElement.style.removeProperty("--color-accent");
    document.documentElement.style.removeProperty("--color-accent-hover");
    document.documentElement.classList.remove(
      "density-compact",
      "density-comfortable",
      "font-small",
      "font-large",
      "reduce-motion",
    );
  });

  it("renders 3 sections (no Appearance)", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Date & Time")).toBeDefined();
    });
    expect(screen.getByText("Task Behavior")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText("Notifications")).toBeDefined();
    });
    // Appearance section should NOT be present
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("renders week start dropdown", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Week starts on")).toBeDefined();
    });
  });

  it("renders date format dropdown with preview", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Date format")).toBeDefined();
    });
    const previews = screen.getAllByText(/e\.g\./);
    expect(previews.length).toBeGreaterThan(0);
  });

  it("renders time format segmented control", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("12-hour")).toBeDefined();
    });
    expect(screen.getByText("24-hour")).toBeDefined();
  });

  it("time format control persists value", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("24-hour")).toBeDefined();
    });
    fireEvent.click(screen.getByText("24-hour"));
    expect(api.setAppSetting).toHaveBeenCalledWith("time_format", "24h");
  });

  it("renders default priority dropdown", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Default priority")).toBeDefined();
    });
  });

  it("default priority dropdown persists value", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Default priority")).toBeDefined();
    });
    const selects = screen.getAllByRole("combobox");
    const prioritySelect = selects.find((s) =>
      Array.from(s.querySelectorAll("option")).some((o) => o.textContent?.includes("Urgent")),
    );
    expect(prioritySelect).toBeDefined();
    fireEvent.change(prioritySelect!, { target: { value: "p2" } });
    expect(api.setAppSetting).toHaveBeenCalledWith("default_priority", "p2");
  });

  it("renders confirm delete toggle", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Confirm before deleting")).toBeDefined();
    });
  });

  it("confirm delete toggle persists value", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Confirm before deleting")).toBeDefined();
    });
    const label = screen.getByText("Confirm before deleting");
    const row = label.closest(".flex")!;
    const toggle = row.querySelector("button")!;
    fireEvent.click(toggle);
    expect(api.setAppSetting).toHaveBeenCalledWith("confirm_delete", "false");
  });

  it("renders start screen dropdown", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Start screen")).toBeDefined();
    });
  });

  it("start screen dropdown persists value", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Start screen")).toBeDefined();
    });
    const selects = screen.getAllByRole("combobox");
    const startSelect = selects.find((s) =>
      Array.from(s.querySelectorAll("option")).some((o) => o.textContent === "Today"),
    );
    expect(startSelect).toBeDefined();
    fireEvent.change(startSelect!, { target: { value: "today" } });
    expect(api.setAppSetting).toHaveBeenCalledWith("start_view", "today");
  });
});
