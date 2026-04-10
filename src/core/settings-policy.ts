type SettingRow = { key: string; value: string };

/**
 * Allowlist of setting keys writable via the generic settings API.
 * Sensitive keys (ai_api_key, ai_oauth_token) are only writable via dedicated AI config endpoints.
 */
export const WRITABLE_SETTING_KEYS = new Set<string>([
  // General / UI preferences
  "accent_color",
  "density",
  "font_size",
  "reduce_animations",
  "week_start",
  "date_format",
  "time_format",
  "default_priority",
  "confirm_delete",
  "start_view",
  "sound_enabled",
  "sound_volume",
  "sound_complete",
  "sound_create",
  "sound_delete",
  "sound_reminder",
  "calendar_default_mode",
  "font_family",
  // Feature toggles
  "feature_sections",
  "feature_kanban",
  "feature_deadlines",
  "feature_duration",
  "feature_someday",
  "feature_comments",
  "feature_stats",
  "feature_chords",
  "feature_cancelled",
  "feature_matrix",
  "feature_calendar",
  "feature_filters_labels",
  "feature_completed",
  "feature_dopamine_menu",
  // Sidebar
  "sidebar_nav_order",
  "sidebar_favorite_views",
  "sidebar_section_order",
  // Capacity & nudges
  "daily_capacity_minutes",
  "nudge_enabled",
  "nudge_overdue_alert",
  "nudge_deadline_approaching",
  "nudge_stale_tasks",
  "nudge_empty_today",
  "nudge_overloaded_day",
  // Quick capture
  "quick_capture_hotkey",
  "quick_capture_enabled",
  // Eat the frog
  "eat_the_frog_enabled",
  "eat_the_frog_morning_only",
  // Plugins
  "community_plugins_enabled",
  // Notifications
  "notif_browser",
  "notif_toast",
  "notif_default_offset",
  // Keyboard shortcuts
  "keyboard_shortcuts",
  // AI (non-sensitive)
  "ai_custom_instructions",
  "ai_daily_briefing",
  "ai_default_energy",
  // Onboarding
  "onboarding_completed",
  // Saved filters
  "saved_filters",
]);

const SENSITIVE_KEY_PATTERNS = ["api_key", "token", "secret", "password"];

export function isSensitiveSettingKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function isWritableSettingKey(key: string): boolean {
  return WRITABLE_SETTING_KEYS.has(key);
}

export function listSettingsForClient(rows: SettingRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (!isSensitiveSettingKey(row.key)) {
      result[row.key] = row.value;
    }
  }
  return result;
}

export function readSettingForClient(key: string, value: string | null | undefined): string | null {
  if (isSensitiveSettingKey(key)) {
    return value ? "[REDACTED]" : null;
  }
  return value ?? null;
}
