import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlertsTab } from "../../../src/ui/views/settings/AlertsTab.js";
import { SettingsProvider } from "../../../src/ui/context/SettingsContext.js";

const settingsApiMocks = vi.hoisted(() => ({
  getAllSettings: vi.fn().mockResolvedValue({}),
  setAppSetting: vi.fn().mockResolvedValue(undefined),
}));
const notificationPluginMocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

vi.mock("../../../src/ui/api/settings.js", () => settingsApiMocks);
vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getAppSetting: vi.fn().mockResolvedValue(null),
    setAppSetting: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../../src/ui/themes/manager.js", () => ({
  themeManager: {
    getCurrent: vi.fn().mockReturnValue("system"),
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue([]),
  },
}));
vi.mock("../../../src/utils/sounds.js", () => ({
  previewSound: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => notificationPluginMocks);
vi.mock("../../../src/ui/api/desktop-server.js", () => ({
  DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT: "junban:desktop-remote-server-status-changed",
  getDesktopRemoteServerStatus: vi.fn().mockResolvedValue({
    available: false,
    running: false,
    port: null,
    localUrl: null,
  }),
}));

const mockNotification = {
  permission: "default" as NotificationPermission,
  requestPermission: vi.fn().mockResolvedValue("granted"),
};
Object.defineProperty(window, "Notification", { value: mockNotification, writable: true });

function renderAlertsTab() {
  return render(
    <SettingsProvider>
      <AlertsTab />
    </SettingsProvider>,
  );
}

describe("AlertsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsApiMocks.getAllSettings.mockResolvedValue({});
    notificationPluginMocks.isPermissionGranted.mockResolvedValue(true);
    notificationPluginMocks.requestPermission.mockResolvedValue("granted");
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("groups notifications, sound effects, and smart nudges", async () => {
    renderAlertsTab();

    await waitFor(() => {
      expect(screen.getByText("Alerts & Feedback")).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sound Effects" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Smart Nudges" })).toBeInTheDocument();
  });

  it("uses app notification copy and native test notifications in desktop runtime", async () => {
    Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
    const user = userEvent.setup();

    renderAlertsTab();

    await waitFor(() => {
      expect(screen.getByText("App notifications")).toBeInTheDocument();
    });

    expect(screen.queryByText("Browser notifications")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send test notification" }));

    expect(notificationPluginMocks.sendNotification).toHaveBeenCalledWith({
      title: "Junban test notification",
      body: "Notifications are working for this app.",
    });
    expect(await screen.findByText("Test notification sent.")).toBeInTheDocument();
  });
});
