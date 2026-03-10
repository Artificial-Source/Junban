import { Volume2 } from "lucide-react";
import { useGeneralSettings } from "../../../context/SettingsContext.js";
import { SettingRow, Toggle } from "../components.js";
import { previewSound, type SoundEvent } from "../../../../utils/sounds.js";

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

export function SoundSection() {
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
