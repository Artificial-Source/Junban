/**
 * Explicit Phase 7 visual fixture gate.
 * Activated only by `visual-fixture=phase-7` + allowlisted `scene` id.
 */

import { isVisualFixture } from "./visualFixture";

export const PHASE7_SCENE_IDS = [
  "settings-extensions-main-desktop-light",
  "settings-extensions-safety-desktop-light",
  "settings-extensions-permission-desktop-light",
  "registry-browser-list-detail-desktop-light",
  "registry-browser-empty-desktop-light",
  "registry-browser-loading-desktop-light",
  "registry-browser-error-desktop-light",
  "plugin-settings-pomodoro-desktop-light",
  "pomodoro-view-status-desktop-light",
  "declarative-panel-action-desktop-light",
  "settings-extensions-mobile-category-light",
  "settings-extensions-mobile-detail-light",
  "pomodoro-view-status-desktop-dark",
] as const;

export type Phase7SceneId = (typeof PHASE7_SCENE_IDS)[number];

const SCENE_SET = new Set<string>(PHASE7_SCENE_IDS);

export type Phase7SceneMeta = {
  id: Phase7SceneId;
  theme: "light" | "dark";
  width: number;
  height: number;
};

export const PHASE7_SCENE_META: Record<Phase7SceneId, Phase7SceneMeta> = {
  "settings-extensions-main-desktop-light": {
    id: "settings-extensions-main-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "settings-extensions-safety-desktop-light": {
    id: "settings-extensions-safety-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "settings-extensions-permission-desktop-light": {
    id: "settings-extensions-permission-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "registry-browser-list-detail-desktop-light": {
    id: "registry-browser-list-detail-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "registry-browser-empty-desktop-light": {
    id: "registry-browser-empty-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "registry-browser-loading-desktop-light": {
    id: "registry-browser-loading-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "registry-browser-error-desktop-light": {
    id: "registry-browser-error-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "plugin-settings-pomodoro-desktop-light": {
    id: "plugin-settings-pomodoro-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "pomodoro-view-status-desktop-light": {
    id: "pomodoro-view-status-desktop-light",
    theme: "light",
    width: 1440,
    height: 900,
  },
  "declarative-panel-action-desktop-light": {
    id: "declarative-panel-action-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "settings-extensions-mobile-category-light": {
    id: "settings-extensions-mobile-category-light",
    theme: "light",
    width: 390,
    height: 844,
  },
  "settings-extensions-mobile-detail-light": {
    id: "settings-extensions-mobile-detail-light",
    theme: "light",
    width: 390,
    height: 844,
  },
  "pomodoro-view-status-desktop-dark": {
    id: "pomodoro-view-status-desktop-dark",
    theme: "dark",
    width: 1440,
    height: 900,
  },
};

export const PHASE7_FIXED_CLOCK = "2026-08-04T15:00:00.000Z";
export const PHASE7_LEGACY_ACCENT = "#8a2be2";

function parseSearch(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
}

export function readPhase7VisualScene(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): Phase7SceneId | null {
  if (!isVisualFixture(search, "phase-7")) return null;
  const scene = parseSearch(search).get("scene");
  if (!scene || !SCENE_SET.has(scene)) return null;
  return scene as Phase7SceneId;
}

export function isPhase7VisualFixture(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  return readPhase7VisualScene(search) !== null;
}

export function applyPhase7VisualEnvironment(scene: Phase7SceneId): void {
  if (typeof document === "undefined") return;
  const meta = PHASE7_SCENE_META[scene];
  const root = document.documentElement;
  root.classList.remove("dark", "nord", "light");
  if (meta.theme === "dark") root.classList.add("dark");
  root.classList.add("reduce-motion");
  root.style.colorScheme = meta.theme === "dark" ? "dark" : "light";
  root.style.setProperty(
    "--color-accent",
    meta.theme === "dark" ? "#bf5af2" : PHASE7_LEGACY_ACCENT,
  );
  root.style.removeProperty("--color-accent-hover");
  root.style.removeProperty("--color-accent-action");
  root.style.removeProperty("--color-accent-action-hover");
  root.style.removeProperty("--color-accent-foreground");
  root.style.removeProperty("--color-accent-foreground-hover");
  root.style.removeProperty("--color-focus");
  root.style.removeProperty("--color-on-accent-action");
  root.dataset.fontFamily = "system";
  root.dataset.fontSize = "medium";
  root.dataset.density = "comfortable";
  root.style.setProperty(
    "--font-sans",
    '"Noto Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  );
  root.style.setProperty(
    "--font-heading",
    '"Noto Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  );
  root.style.setProperty("accent-color", "#3b82f6");
  document.body.classList.add("bg-surface", "text-on-surface", "antialiased");
}
