/** Default application settings and constants. */

export const APP_VERSION = "1.0.0";

export const PRIORITIES = {
  P1: { value: 1, label: "P1", color: "#ef4444" },
  P2: { value: 2, label: "P2", color: "#f59e0b" },
  P3: { value: 3, label: "P3", color: "#3b82f6" },
  P4: { value: 4, label: "P4", color: "#6b7280" },
} as const;

export const TASK_STATUSES = ["pending", "completed", "cancelled"] as const;

export const DEFAULT_PROJECT_COLORS = [
  "#b8255f", // Berry Red
  "#db4035", // Red
  "#ff9933", // Orange
  "#fad000", // Yellow
  "#afb83b", // Olive Green
  "#7ecc49", // Lime Green
  "#299438", // Emerald
  "#6accbc", // Mint Green
  "#158fad", // Teal
  "#14aaf5", // Sky Blue
  "#4073ff", // Blue
  "#884dff", // Grape
  "#af38eb", // Purple
  "#eb96eb", // Violet
  "#e05194", // Magenta
  "#ff8d85", // Pink
  "#808080", // Grey
  "#b8b8a8", // Taupe
  "#ccac93", // Rose
] as const;

export const PROJECT_COLOR_LABELS: Record<string, string> = {
  "#b8255f": "Berry Red",
  "#db4035": "Red",
  "#ff9933": "Orange",
  "#fad000": "Yellow",
  "#afb83b": "Olive Green",
  "#7ecc49": "Lime Green",
  "#299438": "Emerald",
  "#6accbc": "Mint Green",
  "#158fad": "Teal",
  "#14aaf5": "Sky Blue",
  "#4073ff": "Blue",
  "#884dff": "Grape",
  "#af38eb": "Purple",
  "#eb96eb": "Violet",
  "#e05194": "Magenta",
  "#ff8d85": "Pink",
  "#808080": "Grey",
  "#b8b8a8": "Taupe",
  "#ccac93": "Rose",
};

export const COMMAND_PALETTE_HOTKEY = "Ctrl+K";
export const MAX_TASK_TITLE_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 10000;
