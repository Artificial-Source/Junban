/**
 * Pure helpers and shared constants for Phase 4 Settings surfaces.
 */
import type { SettingsTabId } from "../../hooks/useRouting";

/** Legacy project/accent swatch set used by Appearance. */
export const ACCENT_SWATCHES = [
  "#b8255f",
  "#db4035",
  "#ff9933",
  "#fad000",
  "#afb83b",
  "#7ecc49",
  "#299438",
  "#6accbc",
  "#158fad",
  "#14aaf5",
  "#3b82f6",
  "#4073ff",
  "#884dff",
  "#af38eb",
  "#eb96eb",
  "#e05194",
  "#ff8d85",
  "#808080",
  "#b8b8a8",
  "#ccac93",
] as const;

export type SettingsTabMeta = {
  id: SettingsTabId;
  label: string;
  subtitle: string;
};

export const SETTINGS_TAB_META: readonly SettingsTabMeta[] = [
  { id: "essentials", label: "Essentials", subtitle: "Everyday task basics" },
  { id: "appearance", label: "Appearance", subtitle: "Theme & layout" },
  { id: "features", label: "Features", subtitle: "Optional upgrades" },
  { id: "ai", label: "AI", subtitle: "Provider & memory" },
  { id: "voice", label: "Voice", subtitle: "Speech & microphone" },
  { id: "keyboard", label: "Keyboard", subtitle: "Shortcuts" },
  { id: "templates", label: "Templates", subtitle: "Repeatable tasks" },
  { id: "data", label: "Data", subtitle: "Backup & transfer" },
  { id: "hosted", label: "Hosted", subtitle: "Tailnet access" },
  { id: "diagnostics", label: "Diagnostics", subtitle: "Server diagnostics" },
] as const;

export const MOBILE_SETTINGS_SECTIONS: readonly { label: string; tabs: SettingsTabId[] }[] = [
  { label: "Essentials", tabs: ["essentials", "appearance"] },
  { label: "Advanced", tabs: ["features", "ai", "voice", "keyboard", "templates"] },
  { label: "Data", tabs: ["data", "hosted", "diagnostics"] },
];

export function primaryButtonClass(disabled?: boolean): string {
  return `inline-flex items-center justify-center rounded-lg bg-accent-action px-4 py-2 text-sm font-medium text-on-accent-action transition-colors hover:bg-accent-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
    disabled ? "cursor-not-allowed opacity-50" : ""
  }`;
}

export function secondaryButtonClass(disabled?: boolean): string {
  return `inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-on-surface transition-colors hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
    disabled ? "cursor-not-allowed opacity-50" : ""
  }`;
}

export function downloadBlob(artifact: { blob: Blob; filename: string }): void {
  const url = URL.createObjectURL(artifact.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function minutesToTimeInput(total: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.trunc(total)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function timeInputToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** ASCII hostname without ports, wildcards, or path characters. */
export function isValidHostname(value: string): boolean {
  if (!value) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  if (
    value.includes("*") ||
    value.includes(":") ||
    value.includes("/") ||
    value.includes(" ") ||
    value.includes("@")
  ) {
    return false;
  }
  return /^[A-Za-z0-9.-]+$/.test(value);
}

export function dateFormatPreview(
  format: "relative" | "short" | "long" | "iso",
  now: Date = new Date(),
): string {
  switch (format) {
    case "relative":
      return "e.g. Today, Tomorrow, Jan 15";
    case "short":
      return `e.g. ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    case "long":
      return `e.g. ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
    case "iso": {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      return `e.g. ${y}-${m}-${d}`;
    }
    default:
      return "";
  }
}
