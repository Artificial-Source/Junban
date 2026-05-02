import { useState, useEffect } from "react";
import { Bell } from "lucide-react";
import { api } from "../../../api/index.js";
import { Toggle } from "../components.js";
import {
  getAppNotificationPermission,
  getNotificationCopy,
  requestAppNotificationPermission,
  sendAppNotification,
  type AppNotificationPermission,
} from "../../../../utils/notifications.js";

type TestStatus = "idle" | "sent" | "blocked" | "unsupported" | "failed";

export function NotificationSection() {
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [toastEnabled, setToastEnabled] = useState(true);
  const [defaultOffset, setDefaultOffset] = useState("0");
  const [permissionStatus, setPermissionStatus] =
    useState<AppNotificationPermission>("unsupported");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [loaded, setLoaded] = useState(false);
  const notificationCopy = getNotificationCopy();

  useEffect(() => {
    Promise.all([
      api.getAppSetting("notif_browser"),
      api.getAppSetting("notif_toast"),
      api.getAppSetting("notif_default_offset"),
      getAppNotificationPermission(),
    ]).then(([browser, toast, offset, permission]) => {
      if (browser !== null) setBrowserEnabled(browser === "true");
      if (toast !== null) setToastEnabled(toast === "true");
      if (offset !== null) setDefaultOffset(offset);
      setPermissionStatus(permission);
      setLoaded(true);
    });
  }, []);

  const handleBrowserToggle = async () => {
    if (!browserEnabled && permissionStatus !== "granted") {
      const result = await requestAppNotificationPermission();
      setPermissionStatus(result);
      if (result !== "granted") return;
    }
    const next = !browserEnabled;
    setBrowserEnabled(next);
    await api.setAppSetting("notif_browser", String(next));
  };

  const handleToastToggle = async () => {
    const next = !toastEnabled;
    setToastEnabled(next);
    await api.setAppSetting("notif_toast", String(next));
  };

  const handleOffsetChange = async (value: string) => {
    setDefaultOffset(value);
    await api.setAppSetting("notif_default_offset", value);
  };

  const handleRequestPermission = async () => {
    setTestStatus("idle");
    setPermissionStatus(await requestAppNotificationPermission());
  };

  const handleTestNotification = async () => {
    setTestStatus("idle");
    let permission = permissionStatus;

    if (permission !== "granted") {
      permission = await requestAppNotificationPermission();
      setPermissionStatus(permission);
    }

    if (permission === "unsupported") {
      setTestStatus("unsupported");
      return;
    }

    if (permission !== "granted") {
      setTestStatus("blocked");
      return;
    }

    const sent = await sendAppNotification(
      "Junban test notification",
      "Notifications are working for this app.",
    );
    setTestStatus(sent ? "sent" : "failed");
  };

  if (!loaded) return null;

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 text-on-surface flex items-center gap-2">
        <Bell className="w-5 h-5" />
        Notifications
      </h2>
      <div className="space-y-4 max-w-md">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-on-surface">{notificationCopy.label}</p>
            <p className="text-xs text-on-surface-muted">
              Show system notifications when reminders are due
            </p>
          </div>
          <Toggle
            enabled={browserEnabled}
            onToggle={handleBrowserToggle}
            disabled={permissionStatus === "unsupported"}
          />
        </div>
        {permissionStatus === "denied" && (
          <p className="text-xs text-warning">{notificationCopy.blockedMessage}</p>
        )}
        {permissionStatus === "unsupported" && (
          <p className="text-xs text-on-surface-muted">{notificationCopy.unsupportedMessage}</p>
        )}
        {permissionStatus !== "unsupported" && (
          <div className="flex flex-wrap items-center gap-2">
            {permissionStatus !== "granted" && (
              <button
                type="button"
                onClick={handleRequestPermission}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-on-surface hover:bg-surface-secondary transition-colors"
              >
                Request permission
              </button>
            )}
            <button
              type="button"
              onClick={handleTestNotification}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              Send test notification
            </button>
            <p className="basis-full text-xs text-on-surface-muted">
              {permissionStatus === "granted"
                ? "Permission granted."
                : notificationCopy.permissionHint}
            </p>
            {testStatus === "sent" && (
              <p className="basis-full text-xs text-success">Test notification sent.</p>
            )}
            {testStatus === "blocked" && (
              <p className="basis-full text-xs text-warning">{notificationCopy.blockedMessage}</p>
            )}
            {testStatus === "unsupported" && (
              <p className="basis-full text-xs text-on-surface-muted">
                {notificationCopy.unsupportedMessage}
              </p>
            )}
            {testStatus === "failed" && (
              <p className="basis-full text-xs text-warning">
                Junban could not send a test notification. Check your system notification settings.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-on-surface">In-app toast notifications</p>
            <p className="text-xs text-on-surface-muted">
              Show toast messages inside the app for reminders
            </p>
          </div>
          <Toggle enabled={toastEnabled} onToggle={handleToastToggle} />
        </div>

        <div>
          <label className="block text-sm text-on-surface mb-1">Default reminder offset</label>
          <select
            value={defaultOffset}
            onChange={(e) => handleOffsetChange(e.target.value)}
            className="px-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface"
          >
            <option value="0">At time of event</option>
            <option value="5">5 minutes before</option>
            <option value="15">15 minutes before</option>
            <option value="30">30 minutes before</option>
            <option value="60">1 hour before</option>
          </select>
          <p className="text-xs text-on-surface-muted mt-1">
            When setting a reminder from a due date, offset it by this amount.
          </p>
        </div>
      </div>
    </section>
  );
}
