/**
 * Explicit Phase 6 visual fixture gate.
 * Activated only by `visual-fixture=phase-6` + allowlisted `scene` id.
 * Outside this query, every helper returns null and must not change behavior.
 */

import { isVisualFixture } from "./visualFixture";

/** Exact 16-scene allowlist matching the immutable legacy manifest. */
export const PHASE6_SCENE_IDS = [
  "ai-not-configured-panel-desktop-light",
  "ai-welcome-briefing-desktop-light",
  "ai-conversation-tools-desktop-light",
  "ai-chat-history-desktop-light",
  "ai-mobile-view-nav-light",
  "settings-ai-unconfigured-desktop-light",
  "settings-ai-configured-masked-desktop-light",
  "settings-voice-defaults-desktop-light",
  "settings-voice-cloud-desktop-dark",
  "ptt-listening-desktop-light",
  "ptt-transcribing-desktop-light",
  "ptt-error-desktop-light",
  "vad-grace-desktop-light",
  "voice-call-states-desktop-light",
  "focused-task-launch-desktop-light",
  "onboarding-step-ai-desktop-light",
] as const;

export type Phase6SceneId = (typeof PHASE6_SCENE_IDS)[number];

const SCENE_SET = new Set<string>(PHASE6_SCENE_IDS);

export type Phase6SceneMeta = {
  id: Phase6SceneId;
  theme: "light" | "dark";
  width: number;
  height: number;
};

/** Viewport/theme authority frozen with the immutable PNG matrix. */
export const PHASE6_SCENE_META: Record<Phase6SceneId, Phase6SceneMeta> = {
  "ai-not-configured-panel-desktop-light": {
    id: "ai-not-configured-panel-desktop-light",
    theme: "light",
    width: 320,
    height: 720,
  },
  "ai-welcome-briefing-desktop-light": {
    id: "ai-welcome-briefing-desktop-light",
    theme: "light",
    width: 1440,
    height: 900,
  },
  "ai-conversation-tools-desktop-light": {
    id: "ai-conversation-tools-desktop-light",
    theme: "light",
    width: 1440,
    height: 900,
  },
  "ai-chat-history-desktop-light": {
    id: "ai-chat-history-desktop-light",
    theme: "light",
    width: 1440,
    height: 900,
  },
  "ai-mobile-view-nav-light": {
    id: "ai-mobile-view-nav-light",
    theme: "light",
    width: 390,
    height: 844,
  },
  "settings-ai-unconfigured-desktop-light": {
    id: "settings-ai-unconfigured-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "settings-ai-configured-masked-desktop-light": {
    id: "settings-ai-configured-masked-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "settings-voice-defaults-desktop-light": {
    id: "settings-voice-defaults-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "settings-voice-cloud-desktop-dark": {
    id: "settings-voice-cloud-desktop-dark",
    theme: "dark",
    width: 1280,
    height: 900,
  },
  "ptt-listening-desktop-light": {
    id: "ptt-listening-desktop-light",
    theme: "light",
    width: 480,
    height: 320,
  },
  "ptt-transcribing-desktop-light": {
    id: "ptt-transcribing-desktop-light",
    theme: "light",
    width: 480,
    height: 320,
  },
  "ptt-error-desktop-light": {
    id: "ptt-error-desktop-light",
    theme: "light",
    width: 480,
    height: 320,
  },
  "vad-grace-desktop-light": {
    id: "vad-grace-desktop-light",
    theme: "light",
    width: 480,
    height: 420,
  },
  "voice-call-states-desktop-light": {
    id: "voice-call-states-desktop-light",
    theme: "light",
    width: 1280,
    height: 900,
  },
  "focused-task-launch-desktop-light": {
    id: "focused-task-launch-desktop-light",
    theme: "light",
    width: 1440,
    height: 900,
  },
  "onboarding-step-ai-desktop-light": {
    id: "onboarding-step-ai-desktop-light",
    theme: "light",
    width: 720,
    height: 720,
  },
};

/** Synthetic demo copy only — never real secrets, hosts, or prompts. */
export const PHASE6_FIXTURE_COPY = {
  userPrompt: "Plan my documentation tasks for today",
  assistantText:
    "I found three open documentation tasks. I can create a focused plan and add a reminder.",
  toolTaskTitle: "Draft plugin author guide",
  sessionTitles: ["Morning planning", "Inbox triage", "Weekly review prep"] as const,
  focusedTaskTitle: "Review accessibility audit findings",
  focusedTaskId: "task_phase6_focus_001",
} as const;

/** Frozen capture clock (UTC). Local civil hour depends on host TZ (CST → morning). */
export const PHASE6_FIXED_CLOCK = "2026-08-02T15:00:00.000Z";

/** Legacy light-theme purple accent used by the immutable captures. */
export const PHASE6_LEGACY_ACCENT = "#8a2be2";

function parseSearch(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
}

/**
 * Read the allowlisted Phase 6 scene when the exact fixture query is present.
 * Returns null for any other visual-fixture value or unknown scene id.
 */
export function readPhase6VisualScene(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): Phase6SceneId | null {
  if (!isVisualFixture(search, "phase-6")) return null;
  const scene = parseSearch(search).get("scene");
  if (!scene || !SCENE_SET.has(scene)) return null;
  return scene as Phase6SceneId;
}

/** True only inside an allowlisted Phase 6 visual scene. */
export function isPhase6VisualFixture(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  return readPhase6VisualScene(search) !== null;
}

/**
 * Apply deterministic theme tokens for Phase 6 captures.
 * Must run before paint effects that would otherwise touch network/resources.
 */
export function applyPhase6VisualEnvironment(scene: Phase6SceneId): void {
  if (typeof document === "undefined") return;
  const meta = PHASE6_SCENE_META[scene];
  const root = document.documentElement;
  root.classList.remove("dark", "nord", "light");
  if (meta.theme === "dark") root.classList.add("dark");
  root.classList.add("reduce-motion");
  root.style.colorScheme = meta.theme === "dark" ? "dark" : "light";
  // Only pin the base accent. Derived action/foreground tokens must come from the
  // theme stylesheet's oklch() cascade — the immutable captures used those values,
  // not the static hex fallbacks.
  root.style.setProperty(
    "--color-accent",
    meta.theme === "dark" ? "#bf5af2" : PHASE6_LEGACY_ACCENT,
  );
  root.style.removeProperty("--color-accent-hover");
  root.style.removeProperty("--color-accent-action");
  root.style.removeProperty("--color-accent-action-hover");
  root.style.removeProperty("--color-accent-foreground");
  root.style.removeProperty("--color-accent-foreground-hover");
  root.style.removeProperty("--color-focus");
  root.style.removeProperty("--color-on-accent-action");
  // Force the capture host stack: Noto Sans via system-ui (Phase 1/6 authority fonts).
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
  // Native checkbox/radio accent in the capture resolved to browser blue, not purple.
  root.style.setProperty("accent-color", "#3b82f6");
  document.body.classList.add("bg-surface", "text-on-surface", "antialiased");
}
