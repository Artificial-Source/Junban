/**
 * Ephemeral Phase 6 legacy visual fixture state.
 * Read by Vite-aliased mocks; never touches production legacy sources.
 */

export type Phase6SceneId =
  | "ai-not-configured-panel-desktop-light"
  | "ai-welcome-briefing-desktop-light"
  | "ai-conversation-tools-desktop-light"
  | "ai-chat-history-desktop-light"
  | "ai-mobile-view-nav-light"
  | "settings-ai-unconfigured-desktop-light"
  | "settings-ai-configured-masked-desktop-light"
  | "settings-voice-defaults-desktop-light"
  | "settings-voice-cloud-desktop-dark"
  | "ptt-listening-desktop-light"
  | "ptt-transcribing-desktop-light"
  | "ptt-error-desktop-light"
  | "vad-grace-desktop-light"
  | "voice-call-states-desktop-light"
  | "focused-task-launch-desktop-light"
  | "onboarding-step-ai-desktop-light";

export interface Phase6FixtureState {
  scene: Phase6SceneId;
  theme: "light" | "dark";
  /** AI settings fixture */
  aiConfigured: boolean;
  aiHasApiKey: boolean;
  aiProvider: string;
  aiModel: string;
  /** Voice settings fixture */
  voiceSttProviderId: string;
  voiceTtsProviderId: string;
  voiceMode: "off" | "push-to-talk" | "vad";
  voiceGroqApiKeySet: boolean;
  /** PTT mock mode for VoiceButton */
  pttMode: "idle" | "listening" | "transcribing" | "error";
  /** Daily briefing flag for WelcomeScreen */
  dailyBriefing: boolean;
}

declare global {
  interface Window {
    __PHASE6_FIXTURE__?: Phase6FixtureState;
  }
}

export const DEFAULT_FIXTURE: Phase6FixtureState = {
  scene: "ai-not-configured-panel-desktop-light",
  theme: "light",
  aiConfigured: false,
  aiHasApiKey: false,
  aiProvider: "",
  aiModel: "",
  voiceSttProviderId: "browser-stt",
  voiceTtsProviderId: "browser-tts",
  voiceMode: "push-to-talk",
  voiceGroqApiKeySet: false,
  pttMode: "idle",
  dailyBriefing: true,
};

export function readFixture(): Phase6FixtureState {
  if (typeof window !== "undefined" && window.__PHASE6_FIXTURE__) {
    return { ...DEFAULT_FIXTURE, ...window.__PHASE6_FIXTURE__ };
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const scene = (params.get("scene") as Phase6SceneId) || DEFAULT_FIXTURE.scene;
    const theme = (params.get("theme") as "light" | "dark") || "light";
    return { ...DEFAULT_FIXTURE, scene, theme };
  }
  return DEFAULT_FIXTURE;
}

/** Synthetic demo copy only — never real secrets or hostnames. */
export const FIXTURE_COPY = {
  userPrompt: "Plan my documentation tasks for today",
  assistantText:
    "I found three open documentation tasks. I can create a focused plan and add a reminder.",
  toolTaskTitle: "Draft plugin author guide",
  sessionTitles: ["Morning planning", "Inbox triage", "Weekly review prep"],
  focusedTaskTitle: "Review accessibility audit findings",
  focusedTaskId: "task_phase6_focus_001",
} as const;
