import { Hono } from "hono";
import type { AppServices } from "../bootstrap.js";
import { loadEnv } from "../config/env.js";

/** Allowlist of setting keys writable via the settings API.
 *  Sensitive keys (ai_api_key, ai_oauth_token) are only writable via dedicated AI config endpoints. */
const WRITABLE_SETTING_KEYS = new Set([
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

/** Keys that contain sensitive values — redact on read */
const SENSITIVE_KEY_PATTERNS = ["api_key", "token", "secret", "password"];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function settingsRoutes(services: AppServices): Hono {
  const app = new Hono();

  // GET /settings — return all settings as a key-value object (sensitive keys excluded)
  app.get("/", async (c) => {
    const rows = services.storage.listAllAppSettings();
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (!isSensitiveKey(row.key)) {
        result[row.key] = row.value;
      }
    }
    return c.json(result);
  });

  // GET /settings/storage — storage mode info
  app.get("/storage", async (c) => {
    const env = loadEnv();
    return c.json({
      mode: env.STORAGE_MODE,
      path: env.STORAGE_MODE === "markdown" ? env.MARKDOWN_PATH : env.DB_PATH,
    });
  });

  // GET /settings/:key
  app.get("/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    if (isSensitiveKey(key)) {
      const row = services.storage.getAppSetting(key);
      return c.json({ value: row?.value ? "[REDACTED]" : null });
    }
    const row = services.storage.getAppSetting(key);
    return c.json({ value: row?.value ?? null });
  });

  // PUT /settings/:key
  app.put("/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    if (!WRITABLE_SETTING_KEYS.has(key)) {
      return c.json({ error: `Setting key "${key}" is not allowed` }, 400);
    }
    const body = await c.req.json();
    if (typeof body.value !== "string") {
      return c.json({ error: "value must be a string" }, 400);
    }
    services.storage.setAppSetting(key, body.value);
    return c.json({ ok: true });
  });

  return app;
}
