import { useGeneralSettings, type GeneralSettings } from "../../context/SettingsContext.js";
import { SettingRow, Toggle } from "./components.js";

type FeatureKey = Extract<keyof GeneralSettings, `feature_${string}`>;

const FEATURES: {
  key: FeatureKey;
  label: string;
  description: string;
}[] = [
  {
    key: "feature_sections",
    label: "Project sections",
    description: "Group tasks into named sections within projects",
  },
  {
    key: "feature_kanban",
    label: "Kanban / Board view",
    description: "Drag-and-drop board view for projects with sections",
  },
  {
    key: "feature_duration",
    label: "Time estimates",
    description: "Show duration badges on tasks (e.g. 30m, 1h)",
  },
  {
    key: "feature_deadlines",
    label: "Deadlines",
    description: "Separate hard deadline field distinct from the due date",
  },
  {
    key: "feature_comments",
    label: "Comments & activity",
    description: "Add comments and view activity history on tasks",
  },
  {
    key: "feature_calendar",
    label: "Calendar view",
    description: "View tasks on a calendar",
  },
  {
    key: "feature_filters_labels",
    label: "Filters & Labels",
    description: "Saved filters and label management",
  },
  {
    key: "feature_completed",
    label: "Completed tasks view",
    description: "View completed tasks",
  },
  {
    key: "feature_stats",
    label: "Productivity stats",
    description: "Track completion streaks and daily statistics",
  },
  {
    key: "feature_someday",
    label: "Someday / Maybe",
    description: "Park tasks you might do later in a dedicated view",
  },
  {
    key: "feature_cancelled",
    label: "Cancelled tasks view",
    description: "View and restore cancelled tasks",
  },
  {
    key: "feature_chords",
    label: "Keyboard chords",
    description: "Multi-key shortcuts like g then i to jump to Inbox",
  },
  {
    key: "feature_matrix",
    label: "Eisenhower Matrix",
    description: "Priority matrix view for urgent/important categorization",
  },
];

export function FeaturesTab() {
  const { settings, loaded, updateSetting } = useGeneralSettings();

  if (!loaded) return null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-on-surface-muted">
        Toggle features on or off. Disabled features are hidden from the interface but your data is
        preserved.
      </p>
      <div className="space-y-4 max-w-md">
        {FEATURES.map(({ key, label, description }) => (
          <SettingRow key={key} label={label} description={description}>
            <Toggle
              enabled={settings[key] === "true"}
              onToggle={() => updateSetting(key, settings[key] === "true" ? "false" : "true")}
            />
          </SettingRow>
        ))}
      </div>
    </div>
  );
}
