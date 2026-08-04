export function readFixture(): any {
  if (typeof window !== "undefined" && (window as any).__PHASE6_FIXTURE__) {
    return (window as any).__PHASE6_FIXTURE__;
  }
  return {
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
}

export const FIXTURE_COPY = {
  userPrompt: "Plan my documentation tasks for today",
  assistantText:
    "I found three open documentation tasks. I can create a focused plan and add a reminder.",
  toolTaskTitle: "Draft plugin author guide",
  sessionTitles: ["Morning planning", "Inbox triage", "Weekly review prep"],
  focusedTaskTitle: "Review accessibility audit findings",
  focusedTaskId: "task_phase6_focus_001",
} as const;
