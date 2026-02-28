import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { api } from "../api/index.js";

export interface GeneralSettings {
  accent_color: string;
  density: "compact" | "default" | "comfortable";
  font_size: "small" | "default" | "large";
  reduce_animations: "true" | "false";
  week_start: "sunday" | "monday" | "saturday";
  date_format: "relative" | "short" | "long" | "iso";
  time_format: "12h" | "24h";
  default_priority: "none" | "p1" | "p2" | "p3" | "p4";
  confirm_delete: "true" | "false";
  start_view: string;
  sound_enabled: "true" | "false";
  sound_volume: string;
  sound_complete: "true" | "false";
  sound_create: "true" | "false";
  sound_delete: "true" | "false";
  sound_reminder: "true" | "false";
  calendar_default_mode: "day" | "week" | "month";
  font_family: "outfit" | "inter" | "system";
  feature_sections: "true" | "false";
  feature_kanban: "true" | "false";
  feature_deadlines: "true" | "false";
  feature_duration: "true" | "false";
  feature_someday: "true" | "false";
  feature_comments: "true" | "false";
  feature_stats: "true" | "false";
  feature_chords: "true" | "false";
  feature_cancelled: "true" | "false";
  feature_matrix: "true" | "false";
  feature_calendar: "true" | "false";
  feature_filters_labels: "true" | "false";
  feature_completed: "true" | "false";
  sidebar_nav_order: string;
  sidebar_favorite_views: string;
  sidebar_section_order: string;
  daily_capacity_minutes: string;
  nudge_enabled: "true" | "false";
  nudge_overdue_alert: "true" | "false";
  nudge_deadline_approaching: "true" | "false";
  nudge_stale_tasks: "true" | "false";
  nudge_empty_today: "true" | "false";
  nudge_overloaded_day: "true" | "false";
}

const DEFAULT_SETTINGS: GeneralSettings = {
  accent_color: "#3b82f6",
  density: "default",
  font_size: "default",
  reduce_animations: "false",
  week_start: "sunday",
  date_format: "relative",
  time_format: "12h",
  default_priority: "none",
  confirm_delete: "true",
  start_view: "inbox",
  sound_enabled: "true",
  sound_volume: "70",
  sound_complete: "true",
  sound_create: "true",
  sound_delete: "true",
  sound_reminder: "true",
  calendar_default_mode: "week",
  font_family: "outfit",
  feature_sections: "true",
  feature_kanban: "true",
  feature_deadlines: "true",
  feature_duration: "true",
  feature_someday: "true",
  feature_comments: "true",
  feature_stats: "true",
  feature_chords: "true",
  feature_cancelled: "true",
  feature_matrix: "true",
  feature_calendar: "true",
  feature_filters_labels: "true",
  feature_completed: "true",
  sidebar_nav_order: "",
  sidebar_favorite_views: "",
  sidebar_section_order: "",
  daily_capacity_minutes: "480",
  nudge_enabled: "true",
  nudge_overdue_alert: "true",
  nudge_deadline_approaching: "true",
  nudge_stale_tasks: "true",
  nudge_empty_today: "true",
  nudge_overloaded_day: "true",
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof GeneralSettings)[];

interface SettingsContextValue {
  settings: GeneralSettings;
  loaded: boolean;
  updateSetting: <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  updateSetting: () => {},
});

/** Darken a hex color by reducing lightness in HSL space. */
function darkenColor(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  l = Math.max(0, l - amount);

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const gg = Math.round(hue2rgb(p, q, h) * 255);
  const bb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

function applyAccentColor(color: string) {
  document.documentElement.style.setProperty("--color-accent", color);
  document.documentElement.style.setProperty("--color-accent-hover", darkenColor(color, 0.08));
}

function applyDensity(density: GeneralSettings["density"]) {
  const el = document.documentElement;
  el.classList.remove("density-compact", "density-comfortable");
  if (density === "compact") el.classList.add("density-compact");
  else if (density === "comfortable") el.classList.add("density-comfortable");
}

function applyFontSize(size: GeneralSettings["font_size"]) {
  const el = document.documentElement;
  el.classList.remove("font-small", "font-large");
  if (size === "small") el.classList.add("font-small");
  else if (size === "large") el.classList.add("font-large");
}

function applyReduceAnimations(reduce: GeneralSettings["reduce_animations"]) {
  const el = document.documentElement;
  el.classList.toggle("reduce-motion", reduce === "true");
}

function applyFontFamily(family: GeneralSettings["font_family"]) {
  const fonts: Record<GeneralSettings["font_family"], string> = {
    outfit: '"Outfit", ui-sans-serif, system-ui, sans-serif',
    inter: '"Inter", ui-sans-serif, system-ui, sans-serif',
    system: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  };
  document.documentElement.style.setProperty("--font-sans", fonts[family]);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<GeneralSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  // Load all settings on mount
  useEffect(() => {
    let mounted = true;
    Promise.all(SETTING_KEYS.map((key) => api.getAppSetting(key)))
      .then((values) => {
        if (!mounted) return;
        const next = { ...DEFAULT_SETTINGS };
        SETTING_KEYS.forEach((key, i) => {
          if (values[i] !== null) {
            (next as any)[key] = values[i];
          }
        });
        setSettings(next);
        applyAccentColor(next.accent_color);
        applyDensity(next.density);
        applyFontSize(next.font_size);
        applyReduceAnimations(next.reduce_animations);
        applyFontFamily(next.font_family);
        setLoaded(true);
      })
      .catch(() => {
        if (mounted) setLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const updateSetting = useCallback(
    <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        if (key === "accent_color") applyAccentColor(value as string);
        if (key === "density") applyDensity(value as GeneralSettings["density"]);
        if (key === "font_size") applyFontSize(value as GeneralSettings["font_size"]);
        if (key === "reduce_animations")
          applyReduceAnimations(value as GeneralSettings["reduce_animations"]);
        if (key === "font_family") applyFontFamily(value as GeneralSettings["font_family"]);
        return next;
      });
      api.setAppSetting(key, String(value)).catch(() => {});
    },
    [],
  );

  return (
    <SettingsContext.Provider value={{ settings, loaded, updateSetting }}>
      <div className={loaded ? "opacity-100" : "opacity-0"}>{children}</div>
    </SettingsContext.Provider>
  );
}

export function useGeneralSettings() {
  return useContext(SettingsContext);
}
