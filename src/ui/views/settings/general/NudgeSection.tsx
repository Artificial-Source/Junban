import { Lightbulb } from "lucide-react";
import { useGeneralSettings } from "../../../context/SettingsContext.js";
import { SettingRow, Toggle } from "../components.js";

const NUDGE_TYPES: {
  settingKey:
    | "nudge_overdue_alert"
    | "nudge_deadline_approaching"
    | "nudge_stale_tasks"
    | "nudge_empty_today"
    | "nudge_overloaded_day";
  label: string;
  description: string;
}[] = [
  {
    settingKey: "nudge_overdue_alert",
    label: "Overdue tasks",
    description: "Alert when tasks are past their due date",
  },
  {
    settingKey: "nudge_deadline_approaching",
    label: "Approaching deadlines",
    description: "Warn when a deadline is within 24 hours",
  },
  {
    settingKey: "nudge_stale_tasks",
    label: "Stale tasks",
    description: "Notify about tasks pending for 14+ days",
  },
  {
    settingKey: "nudge_empty_today",
    label: "Empty today",
    description: "Remind when no tasks are planned for today",
  },
  {
    settingKey: "nudge_overloaded_day",
    label: "Overloaded day",
    description: "Warn when today exceeds your daily capacity",
  },
];

export function NudgeSection() {
  const { settings, updateSetting } = useGeneralSettings();
  const enabled = settings.nudge_enabled === "true";

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 text-on-surface flex items-center gap-2">
        <Lightbulb className="w-5 h-5" />
        Smart Nudges
      </h2>
      <div className="space-y-4 max-w-md">
        <SettingRow
          label="Enable smart nudges"
          description="Proactive alerts based on your task data (no AI needed)"
        >
          <Toggle
            enabled={enabled}
            onToggle={() => updateSetting("nudge_enabled", enabled ? "false" : "true")}
          />
        </SettingRow>

        {NUDGE_TYPES.map(({ settingKey, label, description }) => (
          <div
            key={settingKey}
            className={`flex items-center justify-between gap-4 ${enabled ? "" : "opacity-50 pointer-events-none"}`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <Toggle
                enabled={settings[settingKey] === "true"}
                onToggle={() =>
                  updateSetting(settingKey, settings[settingKey] === "true" ? "false" : "true")
                }
              />
              <div className="min-w-0">
                <span className="text-sm text-on-surface">{label}</span>
                <p className="text-xs text-on-surface-muted">{description}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
