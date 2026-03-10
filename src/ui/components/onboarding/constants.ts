import { Sun, Moon, Snowflake, Minus, Layers, Rocket } from "lucide-react";
import type { ThemeOption, PresetOption, PresetSettings } from "./types.js";

/** Subset of accent colors — visually distinct, matching the design. */
export const ACCENT_COLORS = [
  "#3b82f6", // Blue (default)
  "#8B5CF6", // Purple
  "#EC4899", // Pink
  "#F59E0B", // Amber
  "#10B981", // Emerald
  "#EF4444", // Red
  "#F97316", // Orange
  "#06B6D4", // Cyan
] as const;

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "light",
    label: "Light",
    icon: Sun,
    iconColor: "text-amber-400",
    cardBg: "bg-white",
    labelColor: "text-gray-900",
    mockBg: "bg-gray-100",
    barColor: "bg-gray-300",
    accentBar: "bg-blue-500",
  },
  {
    id: "dark",
    label: "Dark",
    icon: Moon,
    iconColor: "text-violet-400",
    cardBg: "bg-[#1E1E2E]",
    labelColor: "text-gray-200",
    mockBg: "bg-[#2A2A3C]",
    barColor: "bg-gray-600",
    accentBar: "bg-violet-400",
  },
  {
    id: "nord",
    label: "Nord",
    icon: Snowflake,
    iconColor: "text-[#88C0D0]",
    cardBg: "bg-[#2E3440]",
    labelColor: "text-[#ECEFF4]",
    mockBg: "bg-[#3B4252]",
    barColor: "bg-[#4C566A]",
    accentBar: "bg-[#88C0D0]",
  },
];

export const PRESET_OPTIONS: PresetOption[] = [
  {
    key: "minimal",
    label: "Minimal",
    description: "Just the essentials \u2014 Inbox, Today, Upcoming",
    icon: Minus,
  },
  {
    key: "standard",
    label: "Standard",
    description: "Core views plus calendar, completed tasks, and stats",
    icon: Layers,
  },
  {
    key: "power",
    label: "Everything",
    description: "All views and productivity features enabled",
    icon: Rocket,
  },
];

export const PRESETS: PresetSettings = {
  minimal: {
    feature_calendar: "false",
    feature_filters_labels: "false",
    feature_completed: "false",
    feature_cancelled: "false",
    feature_matrix: "false",
    feature_stats: "false",
    feature_someday: "false",
    feature_chords: "false",
    feature_dopamine_menu: "false",
    eat_the_frog_enabled: "false",
    nudge_enabled: "false",
  },
  standard: {
    feature_calendar: "true",
    feature_filters_labels: "false",
    feature_completed: "true",
    feature_cancelled: "false",
    feature_matrix: "false",
    feature_stats: "true",
    feature_someday: "true",
    feature_chords: "false",
    feature_dopamine_menu: "false",
    eat_the_frog_enabled: "false",
    nudge_enabled: "true",
    nudge_overdue_alert: "true",
    nudge_deadline_approaching: "true",
    nudge_stale_tasks: "false",
    nudge_empty_today: "false",
    nudge_overloaded_day: "false",
  },
  power: {
    feature_calendar: "true",
    feature_filters_labels: "true",
    feature_completed: "true",
    feature_cancelled: "true",
    feature_matrix: "true",
    feature_stats: "true",
    feature_someday: "true",
    feature_chords: "true",
    feature_dopamine_menu: "true",
    eat_the_frog_enabled: "true",
    eat_the_frog_morning_only: "true",
    nudge_enabled: "true",
    nudge_overdue_alert: "true",
    nudge_deadline_approaching: "true",
    nudge_stale_tasks: "true",
    nudge_empty_today: "true",
    nudge_overloaded_day: "true",
  },
} as const;

export const TOTAL_STEPS = 5;
