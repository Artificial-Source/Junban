/**
 * Features — first-party visibility, notification/sound prefs, and nudge rules.
 * Does not expose unsupported AI/voice/plugin/desktop keys.
 */
import type {
  FeatureSettingsDto,
  NotificationSettingsDto,
  NudgeRuleKindDto,
  NudgeRuleSettingsDto,
  PlanningSettingsDto,
  ReminderChannelDto,
} from "../../api/client";
import { previewSound, type SoundEvent } from "../../lib/sounds";
import {
  SettingRow,
  SettingsSection,
  SettingsStatusBanner,
  SettingsToggle,
} from "./settingsComponents";
import { useSettingsSave } from "./useSettingsSave";

const FEATURE_ENTRIES: {
  key: keyof FeatureSettingsDto;
  label: string;
  description: string;
}[] = [
  {
    key: "focus_mode_enabled",
    label: "Focus Mode",
    description: "Single-task focus session with the focus overlay",
  },
  {
    key: "daily_planning_enabled",
    label: "Daily planning",
    description: "Plan My Day and End of Day planning surfaces",
  },
  {
    key: "weekly_review_enabled",
    label: "Weekly review",
    description: "Weekly review command and modal",
  },
  {
    key: "eat_the_frog_enabled",
    label: "Eat the Frog",
    description: "Highlight the hardest task to tackle first",
  },
  {
    key: "task_jar_enabled",
    label: "Task Jar",
    description: "Pull a random ready task when you need a starting point",
  },
  {
    key: "nudges_enabled",
    label: "Smart Nudges",
    description: "Show lightweight reminders based on what is falling behind",
  },
];

const NUDGE_LABELS: Record<NudgeRuleKindDto, { label: string; description: string }> = {
  overdue: {
    label: "Overdue tasks",
    description: "Alert when tasks are past their due date",
  },
  approaching_deadline: {
    label: "Approaching deadlines",
    description: "Warn when a deadline is today or tomorrow",
  },
  stale_task: {
    label: "Stale tasks",
    description: "Notify about tasks pending for many days",
  },
  empty_today: {
    label: "Empty today",
    description: "Remind when no tasks are planned for today",
  },
  overloaded_day: {
    label: "Overloaded day",
    description: "Warn when today exceeds your daily capacity",
  },
};

const CHANNEL_OPTIONS: { value: ReminderChannelDto; label: string; description: string }[] = [
  {
    value: "in_app",
    label: "In-app toasts",
    description: "App-wide: show due-reminder toasts inside Junban",
  },
  {
    value: "web_notification",
    label: "Web notifications",
    description: "App-wide: use an already-granted browser notification permission",
  },
  {
    value: "sound",
    label: "Sound",
    description: "App-wide: allow sound as a delivery channel for due reminders",
  },
];

const SOUND_EVENTS: {
  event: SoundEvent;
  settingKey:
    "task_completed_sound" | "task_created_sound" | "task_deleted_sound" | "reminder_sound";
  label: string;
}[] = [
  { event: "complete", settingKey: "task_completed_sound", label: "Task completed" },
  { event: "create", settingKey: "task_created_sound", label: "Task created" },
  { event: "delete", settingKey: "task_deleted_sound", label: "Task deleted" },
  { event: "reminder", settingKey: "reminder_sound", label: "Reminder" },
];

export function FeaturesTab() {
  const { settings, settingsLoading, settingsError, refreshSettings, savePatch, savingKey, error } =
    useSettingsSave();

  if (settingsLoading && !settings) {
    return <p className="text-sm text-on-surface-muted">Loading settings…</p>;
  }
  if (!settings) {
    return (
      <SettingsStatusBanner kind="error">
        {settingsError ?? "Settings are unavailable."}{" "}
        <button type="button" className="underline" onClick={() => void refreshSettings()}>
          Retry
        </button>
      </SettingsStatusBanner>
    );
  }

  const features = settings.features;
  const notifications = settings.notifications;
  const planning = settings.planning;
  const busy = savingKey !== null;
  const nudgesMaster = features.nudges_enabled;
  const soundMaster = notifications.sound_enabled;
  const volume = notifications.volume_percent;

  const patchFeatures = (partial: Partial<FeatureSettingsDto>) =>
    void savePatch(`features:${Object.keys(partial).join(",")}`, {
      features: { ...features, ...partial },
    });

  const patchNotifications = (partial: Partial<NotificationSettingsDto>) =>
    void savePatch(`notifications:${Object.keys(partial).join(",")}`, {
      notifications: { ...notifications, ...partial },
    });

  const patchPlanning = (next: PlanningSettingsDto) =>
    void savePatch("planning:nudge_rules", { planning: next });

  const toggleChannel = (channel: ReminderChannelDto) => {
    const enabled = notifications.channels.includes(channel);
    let channels = enabled
      ? notifications.channels.filter((item) => item !== channel)
      : [...notifications.channels, channel];
    // Domain requires at least one channel.
    if (channels.length === 0) channels = ["in_app"];
    patchNotifications({ channels });
  };

  const updateNudgeRule = (kind: NudgeRuleKindDto, patch: Partial<NudgeRuleSettingsDto>) => {
    const nudge_rules = planning.nudge_rules.map((rule) =>
      rule.kind === kind ? { ...rule, ...patch } : rule,
    );
    patchPlanning({ ...planning, nudge_rules });
  };

  const handlePreview = (event: SoundEvent) => {
    void previewSound(event, volume).catch(() => {
      // Preview is best-effort; ignore autoplay/policy failures.
    });
  };

  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-on-surface">Features</h2>
        <p className="mt-1 text-sm text-on-surface-muted">
          Optional upgrades for planning depth and power-user workflows. Turn them on only when you
          need them. Your data stays intact when they are off.
        </p>
      </div>

      {error && <SettingsStatusBanner kind="error">{error}</SettingsStatusBanner>}

      <SettingsSection
        title="Sound Effects"
        description="Play short tones for task events and due reminders."
      >
        <SettingRow label="Enable sound effects" description="Master toggle for all sound effects">
          <SettingsToggle
            label="Enable sound effects"
            enabled={soundMaster}
            disabled={busy}
            onToggle={() => patchNotifications({ sound_enabled: !soundMaster })}
          />
        </SettingRow>

        <div className={soundMaster ? "" : "opacity-50"}>
          <SettingRow label="Volume" description={`${volume}%`} controlId="settings-sound-volume">
            <input
              id="settings-sound-volume"
              type="range"
              min={0}
              max={100}
              value={volume}
              disabled={busy || !soundMaster}
              onChange={(event) =>
                patchNotifications({ volume_percent: Number(event.target.value) })
              }
              className="w-32 accent-accent-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </SettingRow>
        </div>

        {SOUND_EVENTS.map(({ event, settingKey, label }) => (
          <div
            key={event}
            className={`flex items-center justify-between gap-4 ${soundMaster ? "" : "opacity-50"}`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <SettingsToggle
                label={label}
                enabled={notifications[settingKey]}
                disabled={busy || !soundMaster}
                onToggle={() => patchNotifications({ [settingKey]: !notifications[settingKey] })}
              />
              <span className="text-sm text-on-surface">{label}</span>
            </div>
            <button
              type="button"
              onClick={() => handlePreview(event)}
              disabled={busy || !soundMaster}
              aria-label={`Preview ${label.toLowerCase()} sound`}
              className="rounded px-2 py-1 text-xs font-medium text-on-surface-secondary transition-colors hover:bg-surface-tertiary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              Preview
            </button>
          </div>
        ))}
      </SettingsSection>

      <SettingsSection
        title="Notifications"
        description="App-wide delivery preferences for due reminders. These are not per-reminder overrides."
      >
        {CHANNEL_OPTIONS.map((channel) => (
          <SettingRow key={channel.value} label={channel.label} description={channel.description}>
            <SettingsToggle
              label={channel.label}
              enabled={notifications.channels.includes(channel.value)}
              disabled={busy}
              onToggle={() => toggleChannel(channel.value)}
            />
          </SettingRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Feature visibility">
        {FEATURE_ENTRIES.map(({ key, label, description }) => (
          <SettingRow key={key} label={label} description={description}>
            <SettingsToggle
              label={label}
              enabled={features[key]}
              disabled={busy}
              onToggle={() => patchFeatures({ [key]: !features[key] })}
            />
          </SettingRow>
        ))}
      </SettingsSection>

      <SettingsSection
        title="Smart Nudges"
        description="Per-rule controls apply when Smart Nudges is enabled above"
      >
        {planning.nudge_rules.map((rule) => {
          const meta = NUDGE_LABELS[rule.kind] ?? {
            label: rule.kind,
            description: "",
          };
          return (
            <SettingRow key={rule.kind} label={meta.label} description={meta.description}>
              <SettingsToggle
                label={meta.label}
                enabled={rule.enabled}
                disabled={busy || !nudgesMaster}
                onToggle={() => updateNudgeRule(rule.kind, { enabled: !rule.enabled })}
              />
            </SettingRow>
          );
        })}
      </SettingsSection>
    </div>
  );
}
