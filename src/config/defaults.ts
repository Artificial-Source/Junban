/** Default application settings and constants. */

export const APP_VERSION = "1.0.7";

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

/** Timeout for plugin onLoad() in milliseconds. */
export const PLUGIN_LOAD_TIMEOUT_MS = 30_000;

/** Timeout for plugin onUnload() in milliseconds. */
export const PLUGIN_UNLOAD_TIMEOUT_MS = 10_000;

/** Timeout for AI tool execution in milliseconds. */
export const TOOL_EXECUTION_TIMEOUT_MS = 15_000;

/** Default base URL for LM Studio's OpenAI-compatible API. */
export const DEFAULT_LMSTUDIO_BASE_URL = "http://localhost:1234/v1";

/** Default base URL for Ollama's native API (without /v1 suffix). */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
