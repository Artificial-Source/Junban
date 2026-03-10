import { useGeneralSettings, type GeneralSettings } from "../../../context/SettingsContext.js";
import { SegmentedControl, SettingRow, SettingSelect } from "../components.js";

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

export function DateTimeSection() {
  const { settings, updateSetting } = useGeneralSettings();
  const now = new Date();

  return (
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
  );
}
