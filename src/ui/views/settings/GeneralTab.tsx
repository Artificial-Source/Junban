import { useGeneralSettings } from "../../context/SettingsContext.js";
import { DateTimeSection } from "./general/DateTimeSection.js";
import { TaskDefaultsSection } from "./general/TaskDefaultsSection.js";
import { SoundSection } from "./general/SoundSection.js";
import { StartupSection } from "./general/StartupSection.js";
import { NudgeSection } from "./general/NudgeSection.js";
import { NotificationSection } from "./general/NotificationSection.js";

// ── Main component ──

export function GeneralTab() {
  const { loaded } = useGeneralSettings();

  if (!loaded) return null;

  return (
    <div className="space-y-8">
      {/* ── Date & Time ── */}
      <DateTimeSection />

      {/* ── Task Behavior ── */}
      <TaskDefaultsSection />

      {/* ── Quick Capture (Tauri only) ── */}
      <StartupSection />

      {/* ── Sound Effects ── */}
      <SoundSection />

      {/* ── Smart Nudges ── */}
      <NudgeSection />

      {/* ── Notifications ── */}
      <NotificationSection />
    </div>
  );
}
