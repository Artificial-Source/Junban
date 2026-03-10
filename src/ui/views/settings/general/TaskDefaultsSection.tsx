import { useGeneralSettings } from "../../../context/SettingsContext.js";
import { SettingRow, SettingSelect, Toggle } from "../components.js";

export function TaskDefaultsSection() {
  const { settings, updateSetting } = useGeneralSettings();

  return (
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

        <SettingRow
          label="Daily capacity"
          description="Target work hours per day (shown in Today view)"
        >
          <SettingSelect
            value={settings.daily_capacity_minutes}
            onChange={(v) => updateSetting("daily_capacity_minutes", v)}
            options={[
              { value: "240", label: "4 hours" },
              { value: "360", label: "6 hours" },
              { value: "480", label: "8 hours" },
              { value: "600", label: "10 hours" },
            ]}
          />
        </SettingRow>
      </div>
    </section>
  );
}
