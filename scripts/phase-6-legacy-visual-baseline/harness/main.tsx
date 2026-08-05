import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@legacy/index.css";
// Providers must resolve through the same overlaid legacy module paths that
// components import (relative ../../context/*), or React context identity breaks.
import { AIProvider } from "@legacy/context/AIContext.js";
import { TaskProvider } from "@legacy/context/TaskContext.js";
import { VoiceProvider } from "@legacy/context/VoiceContext.js";
import { readFixture, type Phase6FixtureState } from "./fixture-state";
import { SceneRouter } from "./scenes";

// Fixed UTC civil clock for greetings / relative session times / briefing window.
const FIXED_NOW = new Date("2026-08-02T15:00:00.000Z");
const RealDate = Date;
class FixtureDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length === 0) {
      super(FIXED_NOW.getTime());
      return;
    }
    // @ts-expect-error Date constructor overload forwarding
    super(...args);
  }
  static now() {
    return FIXED_NOW.getTime();
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).Date = FixtureDate;

function applyTheme(theme: Phase6FixtureState["theme"]) {
  const root = document.documentElement;
  root.classList.remove("dark", "nord", "light", "reduce-motion");
  if (theme === "dark") root.classList.add("dark");
  root.classList.add("reduce-motion");
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
  document.body.classList.add("bg-surface", "text-on-surface", "antialiased");
}

function boot() {
  const params = new URLSearchParams(window.location.search);
  const scene = params.get("scene") ?? "ai-not-configured-panel-desktop-light";
  const theme = (params.get("theme") as "light" | "dark") || "light";
  const preset = params.get("preset") ?? "";

  const fixture: Phase6FixtureState = {
    ...readFixture(),
    scene: scene as Phase6FixtureState["scene"],
    theme,
    dailyBriefing: true,
    aiConfigured: false,
    aiHasApiKey: false,
    aiProvider: "",
    aiModel: "",
    voiceSttProviderId: "browser-stt",
    voiceTtsProviderId: "browser-tts",
    voiceMode: "push-to-talk",
    voiceGroqApiKeySet: false,
    pttMode: "idle",
  };

  if (scene === "settings-ai-configured-masked-desktop-light" || preset === "ai-configured") {
    fixture.aiConfigured = true;
    fixture.aiHasApiKey = true;
    fixture.aiProvider = "openai";
    fixture.aiModel = "gpt-4o";
  }
  if (scene === "settings-voice-cloud-desktop-dark" || preset === "voice-cloud") {
    fixture.voiceSttProviderId = "groq-stt";
    fixture.voiceTtsProviderId = "groq-tts";
    fixture.voiceGroqApiKeySet = true;
    fixture.theme = "dark";
  }
  if (scene === "ptt-listening-desktop-light") fixture.pttMode = "listening";
  if (scene === "ptt-transcribing-desktop-light") fixture.pttMode = "transcribing";
  if (scene === "ptt-error-desktop-light") fixture.pttMode = "error";
  if (
    scene === "ai-conversation-tools-desktop-light" ||
    scene === "ai-chat-history-desktop-light" ||
    scene === "focused-task-launch-desktop-light" ||
    scene === "ai-welcome-briefing-desktop-light"
  ) {
    fixture.aiConfigured = true;
    fixture.aiHasApiKey = true;
    fixture.aiProvider = "openai";
    fixture.aiModel = "gpt-4o";
  }

  window.__PHASE6_FIXTURE__ = fixture;
  applyTheme(fixture.theme);

  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");

  createRoot(root).render(
    <StrictMode>
      <TaskProvider>
        <AIProvider>
          <VoiceProvider>
            <SceneRouter />
          </VoiceProvider>
        </AIProvider>
      </TaskProvider>
    </StrictMode>,
  );

  // Signal readiness only once the scene root has mounted and fonts are ready.
  const markReady = () => {
    if (document.querySelector('[data-testid="phase6-scene-root"]')) {
      document.documentElement.dataset.phase6Ready = "1";
      return true;
    }
    return false;
  };
  void document.fonts.ready.then(() => {
    if (markReady()) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (markReady() || tries > 100) window.clearInterval(timer);
    }, 50);
  });
}

boot();
