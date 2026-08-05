/**
 * Query-scoped Phase 6 visual scene harness.
 * Renders allowlisted scenes through current components with fixture props only.
 * Activated solely by visual-fixture=phase-6&scene=<id>.
 */

import { useEffect, useMemo } from "react";
import { Bot, Mic } from "lucide-react";
import {
  applyPhase6VisualEnvironment,
  PHASE6_FIXTURE_COPY,
  PHASE6_SCENE_META,
  type Phase6SceneId,
} from "../../lib/phase6VisualFixture";
import { AIChatNotConfigured } from "../AIChatNotConfigured";
import { StepAI } from "../StepAI";
import { ChatHistory } from "../chat/ChatHistory";
import { ChatInput } from "../chat/ChatInput";
import { MessageBubble } from "../chat/MessageBubble";
import { WelcomeScreen } from "../chat/WelcomeScreen";
import { BottomNavBar } from "../../components/BottomNavBar";
import { VoiceButton } from "../../voice/VoiceButton";
import { VoiceCallOverlay } from "../../voice/VoiceCallOverlay";
import {
  phase6CallStateFixtures,
  phase6ConversationMessages,
  phase6Sessions,
  phase6VoiceFixture,
  PHASE6_WELCOME_STATS,
} from "./phase6FixtureData";
import { Phase6SettingsAiScene } from "./Phase6SettingsAiScene";
import { Phase6SettingsVoiceScene } from "./Phase6SettingsVoiceScene";

function Shell({
  children,
  width,
  height,
  className = "",
}: {
  children: React.ReactNode;
  width: number;
  height: number;
  className?: string;
}) {
  return (
    <div
      data-testid="phase6-scene-root"
      className={`bg-surface text-on-surface overflow-hidden ${className}`}
      style={{ width, height }}
    >
      {children}
    </div>
  );
}

function ConversationScene({
  scene,
  focused = false,
}: {
  scene: Phase6SceneId;
  focused?: boolean;
}) {
  const messages = phase6ConversationMessages(scene);
  const sessions = phase6Sessions(scene);
  const noop = () => undefined;
  return (
    <Shell width={1440} height={900} className="flex">
      <div className="flex-1 bg-surface-secondary/30 border-r border-border p-6">
        <h1 className="text-lg font-semibold text-on-surface mb-2">Today</h1>
        {focused && (
          <div
            className="rounded-lg px-3 py-2 text-sm text-on-surface mb-4"
            style={{
              border: "1px solid rgb(220, 214, 232)",
              backgroundColor: "rgb(244, 242, 247)",
            }}
          >
            Focused task: <strong>{PHASE6_FIXTURE_COPY.focusedTaskTitle}</strong>
          </div>
        )}
        <p className="text-sm text-on-surface-muted">Workspace chrome (fixture frame)</p>
      </div>
      <aside className="w-[420px] h-full flex flex-col bg-surface border-l border-border">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm text-on-surface flex items-center gap-2">
            <Bot size={16} className="text-accent-foreground" aria-hidden="true" />
            AI Chat
          </h3>
          <span className="text-[10px] text-on-surface-muted">History</span>
        </div>
        {sessions.length > 0 && (
          <ChatHistory
            sessions={sessions}
            activeSessionId={sessions[0]?.id ?? null}
            onNewChat={noop}
            onSwitchSession={noop}
            onDeleteSession={noop}
            onRenameSession={noop}
            mode="panel"
          />
        )}
        <div className="flex-1 overflow-auto px-3 py-3 space-y-3">
          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              mode="panel"
              isLatest={i === messages.length - 1}
            />
          ))}
        </div>
        <ChatInput
          onSubmit={noop}
          isStreaming={false}
          mode="panel"
          voice={{
            buttonState: "idle",
            onTogglePtt: noop,
            showPttButton: true,
            showCallButton: false,
          }}
        />
      </aside>
    </Shell>
  );
}

function WelcomeScene() {
  return (
    <Shell width={1440} height={900} className="flex flex-col">
      <div className="flex-1 flex flex-col min-h-0">
        <WelcomeScreen
          mode="view"
          onSend={() => undefined}
          onDailyBriefing={() => undefined}
          isStreaming={false}
          stats={PHASE6_WELCOME_STATS}
          dailyBriefingEnabled
          greetingOverride="Good morning"
          timeOfDayOverride="morning"
        />
      </div>
      <ChatInput onSubmit={() => undefined} isStreaming={false} mode="view" voice={null} />
    </Shell>
  );
}

function HistoryScene() {
  const sessions = phase6Sessions("ai-chat-history-desktop-light");
  const noop = () => undefined;
  return (
    <Shell width={1440} height={900} className="flex">
      <ChatHistory
        sessions={sessions}
        activeSessionId={sessions[0]?.id ?? null}
        onNewChat={noop}
        onSwitchSession={noop}
        onDeleteSession={noop}
        onRenameSession={noop}
        mode="view"
      />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-end gap-2 p-4">
          <button
            type="button"
            className="text-xs text-on-surface-muted px-2 py-1 rounded hover:bg-surface-tertiary"
          >
            Hide
          </button>
          <button
            type="button"
            className="text-xs text-on-surface-muted px-2 py-1 rounded hover:bg-surface-tertiary"
          >
            Clear
          </button>
        </div>
        <div className="flex-1 overflow-auto max-w-3xl mx-auto w-full px-4 py-6 space-y-4">
          <WelcomeScreen
            mode="view"
            onSend={noop}
            onDailyBriefing={noop}
            isStreaming={false}
            stats={PHASE6_WELCOME_STATS}
            dailyBriefingEnabled
            greetingOverride="Good morning"
            timeOfDayOverride="morning"
          />
        </div>
      </div>
    </Shell>
  );
}

function PttScene({ scene }: { scene: Phase6SceneId }) {
  const voice = phase6VoiceFixture(scene);
  const mode =
    scene === "ptt-listening-desktop-light"
      ? "listening"
      : scene === "ptt-transcribing-desktop-light"
        ? "transcribing"
        : "error";

  // Error: absolute shell-space chrome matched to the immutable capture.
  // Tall field, left-wrapped placeholder, wide nested mic bar, overlaid alert.
  if (scene === "ptt-error-desktop-light") {
    const fieldFill = "rgb(245, 245, 247)";
    const fieldBorder = "rgb(225, 225, 227)";
    return (
      <Shell width={480} height={320} className="relative bg-surface">
        <div
          className="absolute bg-surface border border-border rounded-xl shadow-sm"
          style={{ left: 48, top: 45, width: 384, height: 230 }}
        />
        <p
          className="absolute text-sm font-medium text-on-surface"
          style={{ left: 73, top: 72, margin: 0, lineHeight: "16px" }}
        >
          Push-to-talk · error
        </p>
        <div
          className="absolute"
          style={{
            left: 73,
            top: 106,
            width: 334,
            height: 144,
            boxSizing: "border-box",
            backgroundColor: fieldFill,
            border: `1px solid ${fieldBorder}`,
            borderRadius: 16,
          }}
        />
        <button
          type="button"
          aria-label="Retry voice input"
          data-testid="voice-button"
          data-state="error"
          className="absolute text-on-surface-muted"
          style={{
            left: 145,
            top: 119,
            width: 230,
            height: 33,
            padding: "0 0 0 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            boxSizing: "border-box",
            backgroundColor: fieldFill,
            border: `1px solid ${fieldBorder}`,
            borderRadius: 16,
            lineHeight: 0,
          }}
        >
          <Mic size={14} aria-hidden="true" />
        </button>
        <span
          className="absolute text-sm text-on-surface-muted"
          style={{
            left: 90,
            top: 138,
            width: 48,
            margin: 0,
            lineHeight: "20px",
          }}
        >
          Ask about your tasks...
        </span>
        <div
          role="alert"
          aria-live="assertive"
          className="absolute z-10 text-on-surface"
          style={{
            left: 150,
            top: 161,
            width: 240,
            height: 76,
            padding: 0,
            boxSizing: "border-box",
            backgroundColor: fieldFill,
            border: "1px solid #1d1d1f",
            borderRadius: 4,
            overflow: "hidden",
            fontSize: 12,
            lineHeight: "16px",
          }}
        >
          <p
            style={{
              position: "absolute",
              top: 0,
              left: 1,
              width: 220,
              margin: 0,
            }}
          >
            Microphone access was denied. Allow microphone access in your browser settings, then
            retry.
          </p>
          <button
            type="button"
            className="font-medium"
            style={{
              position: "absolute",
              left: -3,
              top: 48,
              width: 160,
              height: 26,
              padding: "0 8px",
              boxSizing: "border-box",
              backgroundColor: fieldFill,
              border: "1px solid #1d1d1f",
              borderRadius: 3,
              lineHeight: "23px",
              textAlign: "left",
            }}
          >
            Retry microphone access
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell width={480} height={320} className="flex items-center justify-center p-8">
      <div className="rounded-xl border border-border bg-surface p-6 shadow-sm space-y-4 w-full max-w-sm">
        <p className="text-sm font-medium text-on-surface">Push-to-talk · {mode}</p>
        <div className="flex items-center gap-3 rounded-2xl bg-surface-secondary border border-border px-4 py-3">
          <span className="flex-1 text-sm text-on-surface-muted">Ask about your tasks...</span>
          <VoiceButton
            onToggle={() => undefined}
            disabled={false}
            state={voice?.buttonState ?? "idle"}
            permissionError={voice?.buttonPermissionError ?? null}
            onRetry={() => undefined}
          />
        </div>
      </div>
    </Shell>
  );
}

function VadGraceScene() {
  const voice = phase6VoiceFixture("vad-grace-desktop-light");
  return (
    <Shell width={480} height={420} className="flex items-center justify-center p-8">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-4">
        <VoiceCallOverlay
          callState={voice?.callState ?? "listening"}
          callDuration={voice?.callDuration ?? 42}
          onEndCall={() => undefined}
          isInGracePeriod={voice?.isInGracePeriod}
          gracePeriodProgress={voice?.gracePeriodProgress}
        />
      </div>
    </Shell>
  );
}

function VoiceCallStatesScene() {
  const states = phase6CallStateFixtures();
  return (
    <Shell width={1280} height={900} className="grid grid-cols-2 gap-6 p-8 bg-surface-secondary">
      {states.map((s) => (
        <div
          key={s.label}
          className="rounded-xl border border-border bg-surface p-4 flex flex-col items-center"
        >
          <p className="text-xs font-medium text-on-surface-muted mb-2 self-start">{s.label}</p>
          <VoiceCallOverlay
            callState={s.fixture.callState ?? "listening"}
            callDuration={s.fixture.callDuration ?? 0}
            onEndCall={() => undefined}
            recognitionError={s.fixture.recognitionError}
            onRetryRecognition={s.fixture.recognitionError ? () => undefined : undefined}
          />
        </div>
      ))}
    </Shell>
  );
}

function SettingsChrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Shell width={1280} height={900} className="flex items-stretch justify-center p-8">
      <div
        role="dialog"
        aria-label="Settings"
        className="w-full max-w-5xl h-full rounded-2xl border border-border bg-surface shadow-xl flex overflow-hidden"
      >
        <nav
          aria-label="Settings tabs"
          className="w-56 shrink-0 border-r border-border bg-surface-secondary/40 p-4 space-y-1"
        >
          <p className="text-xs font-semibold text-on-surface-muted px-2 mb-3">Settings</p>
          {["Essentials", "Appearance", "AI Assistant", "Voice", "Data"].map((label) => {
            const isActive =
              label === title ||
              (title.startsWith("AI") && label === "AI Assistant") ||
              (title === "Voice" && label === "Voice");
            return (
              <div
                key={label}
                className={`px-3 py-2 rounded-lg text-sm ${
                  isActive
                    ? "bg-accent-action/10 text-accent-foreground font-medium"
                    : "text-on-surface-secondary"
                }`}
              >
                {label}
              </div>
            );
          })}
        </nav>
        <div className="flex-1 overflow-auto p-6">{children}</div>
      </div>
    </Shell>
  );
}

export function Phase6VisualRoot({ scene }: { scene: Phase6SceneId }) {
  const meta = PHASE6_SCENE_META[scene];

  // Apply theme tokens synchronously before paint so dark scenes are not captured light.
  applyPhase6VisualEnvironment(scene);

  useEffect(() => {
    applyPhase6VisualEnvironment(scene);
    document.documentElement.dataset.phase6Ready = "1";
    return () => {
      delete document.documentElement.dataset.phase6Ready;
    };
  }, [scene]);

  const body = useMemo(() => {
    switch (scene) {
      case "ai-not-configured-panel-desktop-light":
        return (
          <Shell width={320} height={720} className="border border-border rounded-xl shadow-sm">
            <AIChatNotConfigured
              onClose={() => undefined}
              onOpenSettings={() => undefined}
              isView={false}
            />
          </Shell>
        );
      case "ai-welcome-briefing-desktop-light":
        return <WelcomeScene />;
      case "ai-conversation-tools-desktop-light":
        return <ConversationScene scene={scene} />;
      case "ai-chat-history-desktop-light":
        return <HistoryScene />;
      case "ai-mobile-view-nav-light":
        return (
          <Shell width={390} height={844} className="relative flex flex-col">
            <div className="flex-1 min-h-0">
              <AIChatNotConfigured
                onClose={() => undefined}
                onOpenSettings={() => undefined}
                isView
              />
            </div>
            <BottomNavBar
              currentView="ai-chat"
              onNavigate={() => undefined}
              onMenuOpen={() => undefined}
              inboxCount={2}
              todayCount={3}
            />
          </Shell>
        );
      case "settings-ai-unconfigured-desktop-light":
        return (
          <SettingsChrome title="AI Assistant">
            <Phase6SettingsAiScene state="unconfigured" />
          </SettingsChrome>
        );
      case "settings-ai-configured-masked-desktop-light":
        return (
          <SettingsChrome title="AI Assistant">
            <Phase6SettingsAiScene state="configured" />
          </SettingsChrome>
        );
      case "settings-voice-defaults-desktop-light":
        return (
          <SettingsChrome title="Voice">
            <Phase6SettingsVoiceScene state="browser" />
          </SettingsChrome>
        );
      case "settings-voice-cloud-desktop-dark":
        return (
          <SettingsChrome title="Voice">
            <Phase6SettingsVoiceScene state="cloud" />
          </SettingsChrome>
        );
      case "ptt-listening-desktop-light":
      case "ptt-transcribing-desktop-light":
      case "ptt-error-desktop-light":
        return <PttScene scene={scene} />;
      case "vad-grace-desktop-light":
        return <VadGraceScene />;
      case "voice-call-states-desktop-light":
        return <VoiceCallStatesScene />;
      case "focused-task-launch-desktop-light":
        return <ConversationScene scene={scene} focused />;
      case "onboarding-step-ai-desktop-light":
        return (
          <Shell
            width={720}
            height={720}
            className="flex items-center justify-center p-8 bg-surface-secondary"
          >
            <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
              <StepAI onSetWantsAI={() => undefined} onNext={() => undefined} />
            </div>
          </Shell>
        );
      default:
        return (
          <Shell
            width={meta.width}
            height={meta.height}
            className="flex items-center justify-center"
          >
            <p>Unknown scene</p>
          </Shell>
        );
    }
  }, [meta.height, meta.width, scene]);

  return body;
}
