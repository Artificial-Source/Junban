import { useState, useEffect } from "react";
import { Bell } from "lucide-react";
import { api } from "../../../api/index.js";
import { Toggle } from "../components.js";

export function NotificationSection() {
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [toastEnabled, setToastEnabled] = useState(true);
  const [defaultOffset, setDefaultOffset] = useState("0");
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission | "unsupported">(
    "Notification" in window ? Notification.permission : "unsupported",
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getAppSetting("notif_browser"),
      api.getAppSetting("notif_toast"),
      api.getAppSetting("notif_default_offset"),
    ]).then(([browser, toast, offset]) => {
      if (browser !== null) setBrowserEnabled(browser === "true");
      if (toast !== null) setToastEnabled(toast === "true");
      if (offset !== null) setDefaultOffset(offset);
      setLoaded(true);
    });
  }, []);

  const handleBrowserToggle = async () => {
    if (!browserEnabled && permissionStatus !== "granted") {
      const result = await Notification.requestPermission();
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
            <p className="text-sm text-on-surface">Browser notifications</p>
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
          <p className="text-xs text-warning">
            Browser notifications are blocked. Update your browser settings to allow notifications.
          </p>
        )}
        {permissionStatus === "unsupported" && (
          <p className="text-xs text-on-surface-muted">
            Browser notifications are not supported in this environment.
          </p>
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
