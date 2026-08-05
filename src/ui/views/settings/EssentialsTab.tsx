/**
 * Essentials — Date & Time, Task Behavior, and Planning from typed settings.
 */
import type {
  DateTimeSettingsDto,
  PlanningSettingsDto,
  TaskDefaultsDto,
  TaskViewPresetDto,
} from "../../api/client";
import {
  SettingRow,
  SettingSelect,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsStatusBanner,
  SettingsToggle,
} from "./settingsComponents";
import { dateFormatPreview, minutesToTimeInput, timeInputToMinutes } from "./settingsHelpers";
import { useSettingsSave } from "./useSettingsSave";

/** Legacy start screens only; the backend enum may remain broader. */
const VIEW_OPTIONS: {
  value: Extract<TaskViewPresetDto, "inbox" | "today" | "upcoming">;
  label: string;
}[] = [
  { value: "inbox", label: "Inbox" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
];

export function EssentialsTab() {
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

  const busy = savingKey !== null;
  const dateTime = settings.date_time;
  const taskDefaults = settings.task_defaults;
  const planning = settings.planning;
  const workHours = planning.work_hours ?? null;

  const patchDateTime = (partial: Partial<DateTimeSettingsDto>) =>
    void savePatch(`date_time:${Object.keys(partial).join(",")}`, {
      date_time: { ...dateTime, ...partial },
    });

  const patchTaskDefaults = (partial: Partial<TaskDefaultsDto>) =>
    void savePatch(`task_defaults:${Object.keys(partial).join(",")}`, {
      task_defaults: { ...taskDefaults, ...partial },
    });

  const patchPlanning = (partial: Partial<PlanningSettingsDto>) =>
    void savePatch(`planning:${Object.keys(partial).join(",")}`, {
      planning: { ...planning, ...partial },
    });

  return (
    <div className="space-y-8">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-on-surface">Essentials</h2>
        <p className="mt-1 text-sm text-on-surface-muted">
          Core preferences for how Junban looks and behaves day to day.
        </p>
      </div>

      {error && <SettingsStatusBanner kind="error">{error}</SettingsStatusBanner>}

      <SettingsSection title="Date & Time">
        <SettingRow label="Week starts on">
          <SettingSelect
            label="Week starts on"
            value={dateTime.week_start}
            disabled={busy}
            onChange={(value) =>
              patchDateTime({ week_start: value as DateTimeSettingsDto["week_start"] })
            }
            options={[
              { value: "sunday", label: "Sunday" },
              { value: "monday", label: "Monday" },
              { value: "saturday", label: "Saturday" },
            ]}
          />
        </SettingRow>

        <SettingRow label="Date format" description={dateFormatPreview(dateTime.date_format)}>
          <SettingSelect
            label="Date format"
            value={dateTime.date_format}
            disabled={busy}
            onChange={(value) =>
              patchDateTime({ date_format: value as DateTimeSettingsDto["date_format"] })
            }
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
          description={dateTime.time_format === "h12" ? "e.g. 2:30 PM" : "e.g. 14:30"}
          group
        >
          <SettingsSegmentedControl
            label="Time format"
            disabled={busy}
            options={[
              { value: "h12", label: "12-hour" },
              { value: "h24", label: "24-hour" },
            ]}
            value={dateTime.time_format}
            onChange={(value) => patchDateTime({ time_format: value })}
          />
        </SettingRow>

        <SettingRow
          label="Default calendar view"
          description="Initial view mode when opening the calendar"
          group
        >
          <SettingsSegmentedControl
            label="Default calendar view"
            disabled={busy}
            options={[
              { value: "day", label: "Day" },
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ]}
            value={dateTime.calendar_default}
            onChange={(value) => patchDateTime({ calendar_default: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Task Behavior">
        <SettingRow
          label="Default priority"
          description="Applied when creating tasks without an explicit priority"
        >
          <SettingSelect
            label="Default priority"
            value={
              taskDefaults.default_priority == null ? "none" : `p${taskDefaults.default_priority}`
            }
            disabled={busy}
            onChange={(value) =>
              patchTaskDefaults({
                default_priority: value === "none" ? null : Number(value.slice(1)),
              })
            }
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
          <SettingsToggle
            label="Confirm before deleting"
            enabled={taskDefaults.confirm_before_delete}
            disabled={busy}
            onToggle={() =>
              patchTaskDefaults({
                confirm_before_delete: !taskDefaults.confirm_before_delete,
              })
            }
          />
        </SettingRow>

        <SettingRow label="Start screen" description="Default view when opening the app">
          <SettingSelect
            label="Start screen"
            value={taskDefaults.default_view}
            disabled={busy}
            onChange={(value) => patchTaskDefaults({ default_view: value as TaskViewPresetDto })}
            options={VIEW_OPTIONS}
          />
        </SettingRow>

        <SettingRow
          label="Daily capacity"
          description="Target work hours per day (shown in Today view)"
        >
          <SettingSelect
            label="Daily capacity"
            value={String(planning.capacity_minutes)}
            disabled={busy}
            onChange={(value) => patchPlanning({ capacity_minutes: Number(value) })}
            options={[
              { value: "240", label: "4 hours" },
              { value: "360", label: "6 hours" },
              { value: "480", label: "8 hours" },
              { value: "600", label: "10 hours" },
              { value: "720", label: "12 hours" },
            ]}
          />
        </SettingRow>

        <SettingRow
          label="Limit planning to work hours"
          description="Optional start and end times in local minutes"
        >
          <SettingsToggle
            label="Limit planning to work hours"
            enabled={workHours !== null}
            disabled={busy}
            onToggle={() =>
              patchPlanning({
                work_hours: workHours ? null : { start_minute: 9 * 60, end_minute: 17 * 60 },
              })
            }
          />
        </SettingRow>

        {workHours && (
          <>
            <SettingRow label="Work hours start">
              <input
                type="time"
                aria-label="Work hours start"
                disabled={busy}
                value={minutesToTimeInput(workHours.start_minute)}
                onChange={(event) => {
                  const minutes = timeInputToMinutes(event.target.value);
                  if (minutes == null) return;
                  patchPlanning({
                    work_hours: { ...workHours, start_minute: minutes },
                  });
                }}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface disabled:opacity-50"
              />
            </SettingRow>
            <SettingRow label="Work hours end">
              <input
                type="time"
                aria-label="Work hours end"
                disabled={busy}
                value={minutesToTimeInput(workHours.end_minute)}
                onChange={(event) => {
                  const minutes = timeInputToMinutes(event.target.value);
                  if (minutes == null) return;
                  patchPlanning({
                    work_hours: { ...workHours, end_minute: minutes },
                  });
                }}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface disabled:opacity-50"
              />
            </SettingRow>
          </>
        )}
      </SettingsSection>
    </div>
  );
}
