import { useState, useEffect } from "react";
import { Bell, Volume2 } from "lucide-react";
import { api } from "../../api/index.js";
import { useGeneralSettings, type GeneralSettings } from "../../context/SettingsContext.js";
import { SegmentedControl, SettingRow, SettingSelect, Toggle } from "./components.js";
import { previewSound, type SoundEvent } from "../../../utils/sounds.js";

// ── Main component ──

export function GeneralTab() {
  const { settings, loaded, updateSetting } = useGeneralSettings();

  if (!loaded) return null;

  const now = new Date();

  return (
    <div className="space-y-8">
      {/* ── Date & Time ── */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-on-surface">Date &amp; Time</h2>
        <div className="space-y-4 max-w-md">
          <SettingRow label="Week starts on">
            <SettingSelect
              value={settings.week_start}
              onChange={(v) => updateSetting("week_start", v)}
              options={[
                { value: "sunday", label: "Sunday" },
                { value: "monday", label: "Monday" },
                { value: "saturday", label: "Saturday" },
              ]}
            />
          </SettingRow>

          <SettingRow
            label="Date format"
            description={dateFormatPreview(settings.date_format, now)}
          >
            <SettingSelect
              value={settings.date_format}
              onChange={(v) => updateSetting("date_format", v)}
              options={[
                { value: "relative", label: "Relative" },
                { value: "short", label: "Short" },
                { value: "long", label: "Long" },
                { value: "iso", label: "ISO" },
              ]}
            />
          </SettingRow>

          <SettingRow
            label="Time format"
            description={settings.time_format === "12h" ? "e.g. 2:30 PM" : "e.g. 14:30"}
          >
            <SegmentedControl
              options={[
                { value: "12h" as const, label: "12-hour" },
                { value: "24h" as const, label: "24-hour" },
              ]}
              value={settings.time_format}
              onChange={(v) => updateSetting("time_format", v)}
            />
          </SettingRow>

          <SettingRow
            label="Default calendar view"
            description="Initial view mode when opening the calendar"
          >
            <SegmentedControl
              options={[
                { value: "day" as const, label: "Day" },
                { value: "week" as const, label: "Week" },
                { value: "month" as const, label: "Month" },
              ]}
              value={settings.calendar_default_mode}
              onChange={(v) => updateSetting("calendar_default_mode", v)}
            />
          </SettingRow>
        </div>
      </section>

      {/* ── Task Behavior ── */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-on-surface">Task Behavior</h2>
        <div className="space-y-4 max-w-md">
          <SettingRow
            label="Default priority"
            description="Applied when creating tasks without an explicit priority"
          >
            <SettingSelect
              value={settings.default_priority}
              onChange={(v) => updateSetting("default_priority", v)}
              options={[
                { value: "none", label: "None" },
                { value: "p1", label: "P1 — Urgent" },
                { value: "p2", label: "P2 — High" },
                { value: "p3", label: "P3 — Medium" },
                { value: "p4", label: "P4 — Low" },
              ]}
            />
          </SettingRow>

          <SettingRow
            label="Confirm before deleting"
            description="Show a confirmation dialog when deleting tasks"
          >
            <Toggle
              enabled={settings.confirm_delete === "true"}
              onToggle={() =>
                updateSetting(
                  "confirm_delete",
                  settings.confirm_delete === "true" ? "false" : "true",
                )
              }
            />
          </SettingRow>

          <SettingRow label="Start screen" description="Default view when opening the app">
            <SettingSelect
              value={settings.start_view}
              onChange={(v) => updateSetting("start_view", v)}
              options={[
                { value: "inbox", label: "Inbox" },
                { value: "today", label: "Today" },
                { value: "upcoming", label: "Upcoming" },
              ]}
            />
          </SettingRow>
        </div>
      </section>

      {/* ── Sound Effects ── */}
      <SoundSettings />

      {/* ── Notifications ── */}
      <NotificationSettings />
    </div>
  );
}

const SOUND_EVENTS: {
  event: SoundEvent;
  settingKey: "sound_complete" | "sound_create" | "sound_delete" | "sound_reminder";
  label: string;
}[] = [
  { event: "complete", settingKey: "sound_complete", label: "Task completed" },
  { event: "create", settingKey: "sound_create", label: "Task created" },
  { event: "delete", settingKey: "sound_delete", label: "Task deleted" },
  { event: "reminder", settingKey: "sound_reminder", label: "Reminder" },
];

function SoundSettings() {
  const { settings, updateSetting } = useGeneralSettings();
  const enabled = settings.sound_enabled === "true";
  const volume = parseInt(settings.sound_volume, 10) || 0;

  const handlePreview = (event: SoundEvent) => {
    previewSound(event, volume / 100).catch(() => {});
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 text-on-surface flex items-center gap-2">
        <Volume2 className="w-5 h-5" />
        Sound Effects
      </h2>
      <div className="space-y-4 max-w-md">
        <SettingRow label="Enable sound effects" description="Play sounds for task events">
          <Toggle
            enabled={enabled}
            onToggle={() => updateSetting("sound_enabled", enabled ? "false" : "true")}
          />
        </SettingRow>

        <div className={enabled ? "" : "opacity-50 pointer-events-none"}>
          <SettingRow label="Volume" description={`${volume}%`}>
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => updateSetting("sound_volume", e.target.value)}
              className="w-32 accent-[var(--color-accent)]"
            />
          </SettingRow>
        </div>

        {SOUND_EVENTS.map(({ event, settingKey, label }) => (
          <div
            key={event}
            className={`flex items-center justify-between gap-4 ${enabled ? "" : "opacity-50 pointer-events-none"}`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <Toggle
                enabled={settings[settingKey] === "true"}
                onToggle={() =>
                  updateSetting(settingKey, settings[settingKey] === "true" ? "false" : "true")
                }
              />
              <span className="text-sm text-on-surface">{label}</span>
            </div>
            <button
              onClick={() => handlePreview(event)}
              className="text-xs text-accent hover:text-accent-hover px-2 py-1 rounded transition-colors"
            >
              Preview
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function dateFormatPreview(format: GeneralSettings["date_format"], now: Date): string {
  switch (format) {
    case "relative":
      return `e.g. Today, Tomorrow, Jan 15`;
    case "short":
      return `e.g. ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    case "long":
      return `e.g. ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
    case "iso": {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      return `e.g. ${y}-${m}-${d}`;
    }
    default:
      return "";
  }
}

function NotificationSettings() {
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
