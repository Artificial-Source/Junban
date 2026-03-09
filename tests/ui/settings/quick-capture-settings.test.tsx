import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GeneralTab } from "../../../src/ui/views/settings/GeneralTab.js";
import { SettingsProvider } from "../../../src/ui/context/SettingsContext.js";

// Mock api
vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getAppSetting: vi.fn().mockResolvedValue(null),
    setAppSetting: vi.fn().mockResolvedValue(undefined),
  },
}));

import { api } from "../../../src/ui/api/index.js";

// Mock themeManager
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

// Mock isTauri — controlled via mockIsTauri
const mockIsTauri = vi.fn(() => true);
vi.mock("../../../src/utils/tauri.js", () => ({
  isTauri: () => mockIsTauri(),
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

describe("Quick Capture Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(true);
    (api.getAppSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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

  it("renders Quick Capture section when isTauri() is true", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Quick Capture")).toBeDefined();
    });
  });

  it("hides Quick Capture section when isTauri() is false", async () => {
    mockIsTauri.mockReturnValue(false);

    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Date & Time")).toBeDefined();
    });
    expect(screen.queryByText("Quick Capture")).toBeNull();
  });

  it("shows the default hotkey", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("CmdOrCtrl+Shift+Space")).toBeDefined();
    });
  });

  it("has Record and Reset buttons", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Record")).toBeDefined();
      expect(screen.getByText("Reset")).toBeDefined();
    });
  });

  it("switches to recording mode when Record is clicked", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Record")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Record"));
    expect(screen.getByText("Press keys...")).toBeDefined();
    expect(screen.getByText("Cancel")).toBeDefined();
  });

  it("resets hotkey to default when Reset is clicked", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Reset")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Reset"));

    await waitFor(() => {
      expect(api.setAppSetting).toHaveBeenCalledWith(
        "quick_capture_hotkey",
        "CmdOrCtrl+Shift+Space",
      );
    });
  });

  it("has an enable/disable toggle for quick capture", async () => {
    renderGeneralTab();
    await waitFor(() => {
      expect(screen.getByText("Enable quick capture")).toBeDefined();
    });
  });
});
