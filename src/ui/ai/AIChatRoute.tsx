/**
 * Wave 4d lazy AI chat route entry.
 *
 * Loads confirmed AI config only on route entry. Never pulls provider/voice/
 * local-engine chunks. Renders legacy not-configured shell when disabled.
 */
import { useEffect, useState } from "react";
import type { TaskDto } from "../api/client";
import { getTask } from "../api/client";
import { useLocalVoiceAdapters } from "../voice/useLocalVoiceAdapters";
import { AIChatNotConfigured } from "./AIChatNotConfigured";
import { AIChatPanel, type AIChatPanelFixture } from "./AIChatPanel";
import { isAiConfigured } from "./config-status";
import { readFocusedTaskId, readFocusedTaskPrompt } from "./focused-task";
import { getAiConfig } from "./transport";
import type { AiConfigResponse } from "./types";
import type { WelcomeStats } from "./chat";

export interface AIChatRouteProps {
  onOpenSettings: () => void;
  onOpenVoiceSettings?: () => void;
  onSelectTask?: (taskId: string) => void;
  welcomeStats?: WelcomeStats;
  /**
   * Explicit fixture view-model for visual/unit tests only.
   * Production AppLayout must not pass this prop.
   */
  fixture?: AIChatRouteFixture;
}

export type AIChatRouteFixture = AIChatPanelFixture & {
  forceNotConfigured?: boolean;
  config?: AiConfigResponse | null;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; config: AiConfigResponse }
  | { status: "error"; message: string };

export function AIChatRoute({
  onOpenSettings,
  onOpenVoiceSettings,
  onSelectTask,
  welcomeStats,
  fixture,
}: AIChatRouteProps) {
  const [loadState, setLoadState] = useState<LoadState>(() =>
    fixture
      ? fixture.forceNotConfigured
        ? {
            status: "ready",
            config: emptyDisabledConfig(),
          }
        : {
            status: "ready",
            config: fixture.config ?? emptyEnabledConfig(),
          }
      : { status: "loading" },
  );

  const [focusedTaskId] = useState<string | null>(() => (fixture ? null : readFocusedTaskId()));
  const [launchPrompt] = useState<string | null>(() => (fixture ? null : readFocusedTaskPrompt()));
  const [focusedTask, setFocusedTask] = useState<TaskDto | null>(null);

  const configuredReady =
    !fixture && loadState.status === "ready" && isAiConfigured(loadState.config);
  const localVoice = useLocalVoiceAdapters({
    settings: configuredReady && loadState.status === "ready" ? loadState.config.voice : null,
    // Fixtures and not-configured shells must not construct local adapters.
    enabled: configuredReady,
  });

  // Production: load confirmed config once on entry.
  useEffect(() => {
    if (fixture) return;
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const config = await getAiConfig({ signal: controller.signal });
        if (cancelled) return;
        setLoadState({ status: "ready", config });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Failed to load AI configuration.";
        setLoadState({ status: "error", message });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fixture]);

  // Validate/fetch focused task on reload when query present.
  useEffect(() => {
    if (fixture || !focusedTaskId) {
      setFocusedTask(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const task = await getTask(focusedTaskId);
        if (!cancelled) setFocusedTask(task);
      } catch {
        if (!cancelled) setFocusedTask(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixture, focusedTaskId]);

  if (loadState.status === "loading") {
    return (
      <div
        className="flex h-full min-h-[20rem] w-full flex-1 flex-col items-center justify-center text-on-surface-secondary text-sm"
        role="status"
        aria-label="Loading AI configuration"
      >
        Loading AI…
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="flex h-full min-h-[20rem] w-full flex-1 flex-col items-center justify-center p-6 text-center">
        <p className="text-sm text-error mb-3" role="alert">
          {loadState.message}
        </p>
        <button
          type="button"
          onClick={onOpenSettings}
          className="px-4 py-2 text-sm bg-accent-action text-on-accent-action rounded-lg hover:bg-accent-action-hover transition-colors"
        >
          Open Settings
        </button>
      </div>
    );
  }

  const configured = !fixture?.forceNotConfigured && isAiConfigured(loadState.config);

  if (!configured) {
    return (
      <div className="flex h-full min-h-[20rem] w-full flex-1 flex-col">
        <AIChatNotConfigured
          isView
          onClose={() => {
            /* View mode has no close control. */
          }}
          onOpenSettings={onOpenSettings}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[20rem] w-full flex-1 flex-col">
      <AIChatPanel
        onOpenSettings={onOpenSettings}
        onOpenVoiceSettings={onOpenVoiceSettings}
        onSelectTask={onSelectTask}
        focusedTaskId={focusedTaskId}
        focusedTaskTitle={focusedTask?.title ?? fixture?.focusedTaskTitle ?? null}
        dailyBriefingEnabled={loadState.config.ai.daily_briefing_enabled}
        autoSend={loadState.config.ai.auto_send}
        launchPrompt={launchPrompt}
        welcomeStats={welcomeStats}
        voiceSettings={loadState.config.voice}
        localStt={localVoice.localStt}
        localTts={localVoice.localTts}
        fixture={fixture}
      />
    </div>
  );
}

function emptyDisabledConfig(): AiConfigResponse {
  return {
    ai: {
      enabled: false,
      provider: null,
      model: null,
      base_url: null,
      credential_id: null,
      custom_instructions: "",
      daily_briefing_enabled: false,
      default_energy: null,
      smart_endpoint: false,
      auto_send: false,
    },
    voice: {
      stt_provider: "browser",
      stt_model: null,
      tts_provider: "browser",
      tts_model: null,
      tts_voice: null,
      stt_credential_id: null,
      tts_credential_id: null,
      cloud_speech_enabled: false,
      tts_enabled: false,
      voice_mode: "push_to_talk",
      grace_period_ms: 1000,
    },
    credentials: {
      ai_provider: null,
      voice_stt: null,
      voice_tts: null,
    },
  };
}

function emptyEnabledConfig(): AiConfigResponse {
  const base = emptyDisabledConfig();
  return {
    ...base,
    ai: {
      ...base.ai,
      enabled: true,
      provider: "ollama",
      model: "test-model",
      base_url: "http://127.0.0.1:11434",
    },
  };
}
