import { Bot } from "lucide-react";
import { AIChatNotConfigured } from "@legacy/components/chat/AIChatNotConfigured.js";
import { WelcomeScreen } from "@legacy/components/chat/WelcomeScreen.js";
import { MessageBubble } from "@legacy/components/chat/MessageBubble.js";
import { ChatHistory } from "@legacy/components/chat/ChatHistory.js";
import { ChatInput } from "@legacy/components/chat/ChatInput.js";
import { VoiceButton } from "@legacy/components/chat/VoiceButton.js";
import { VoiceCallOverlay } from "@legacy/components/VoiceCallOverlay.js";
import { BottomNavBar } from "@legacy/components/BottomNavBar.js";
import { StepAI } from "@legacy/components/onboarding/StepAI.js";
import { AITab } from "@legacy/views/settings/AITab.js";
import { VoiceTab } from "@legacy/views/settings/VoiceTab.js";
// Context hooks must share module identity with the overlaid legacy paths.
import { useAIContext } from "@legacy/context/AIContext.js";
import { useVoiceContext } from "@legacy/context/VoiceContext.js";
import { FIXTURE_COPY, type Phase6SceneId, readFixture } from "./fixture-state";

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

function SettingsChrome({
  title,
  children,
  width = 1280,
  height = 900,
}: {
  title: string;
  children: React.ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <Shell width={width} height={height} className="flex items-stretch justify-center p-8">
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

function PanelChrome({
  children,
  showHistory = false,
  width = 320,
  height = 720,
}: {
  children: React.ReactNode;
  showHistory?: boolean;
  width?: number;
  height?: number;
}) {
  const { sessions, activeSessionId } = useAIContext();
  return (
    <Shell width={width} height={height} className="border border-border rounded-xl shadow-sm">
      <aside className="w-full h-full flex flex-col bg-surface">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm text-on-surface flex items-center gap-2">
            <Bot size={16} className="text-accent-foreground" />
            AI Chat
          </h3>
          <span className="text-[10px] text-on-surface-muted">
            {showHistory ? "History" : "Panel"}
          </span>
        </div>
        {showHistory && sessions.length > 0 && (
          <ChatHistory
            sessions={sessions}
            activeSessionId={activeSessionId}
            onNewChat={() => undefined}
            onSwitchSession={() => undefined}
            onDeleteSession={() => undefined}
            onRenameSession={() => undefined}
            mode="panel"
          />
        )}
        {children}
      </aside>
    </Shell>
  );
}

function ConversationScene({ focused = false }: { focused?: boolean }) {
  const { messages, sessions, activeSessionId } = useAIContext();
  const voice = useVoiceContext();
  return (
    <Shell width={1440} height={900} className="flex">
      <div className="flex-1 bg-surface-secondary/30 border-r border-border p-6">
        <h1 className="text-lg font-semibold text-on-surface mb-2">Today</h1>
        {focused && (
          <div className="rounded-lg border border-accent-action/30 bg-accent-action/5 px-3 py-2 text-sm text-on-surface mb-4">
            Focused task: <strong>{FIXTURE_COPY.focusedTaskTitle}</strong>
          </div>
        )}
        <p className="text-sm text-on-surface-muted">Workspace chrome (fixture frame)</p>
      </div>
      <aside className="w-[420px] h-full flex flex-col bg-surface border-l border-border">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm text-on-surface flex items-center gap-2">
            <Bot size={16} className="text-accent-foreground" />
            AI Chat
          </h3>
          <span className="text-[10px] text-on-surface-muted">History</span>
        </div>
        {sessions.length > 0 && (
          <ChatHistory
            sessions={sessions}
            activeSessionId={activeSessionId}
            onNewChat={() => undefined}
            onSwitchSession={() => undefined}
            onDeleteSession={() => undefined}
            onRenameSession={() => undefined}
            mode="panel"
          />
        )}
        <div className="flex-1 overflow-auto px-3 py-3 space-y-3">
          {messages.map((msg, i) => (
            <MessageBubble
              key={i}
              message={msg}
              mode="panel"
              messageIndex={i}
              onSelectTask={() => undefined}
              isLatest={i === messages.length - 1}
            />
          ))}
        </div>
        <ChatInput
          onSubmit={() => undefined}
          isStreaming={false}
          mode="panel"
          voice={voice}
          ttsAvailable={false}
          onVoiceResult={() => undefined}
          showCallButton={false}
        />
      </aside>
    </Shell>
  );
}

function WelcomeScene() {
  return (
    <Shell width={1440} height={900} className="flex flex-col">
      <div className="flex-1 flex flex-col">
        <WelcomeScreen mode="view" onSend={() => undefined} isStreaming={false} />
      </div>
      <div className="border-t border-border p-4">
        <div className="max-w-3xl mx-auto rounded-2xl bg-surface-secondary border border-border px-4 py-3 text-sm text-on-surface-muted">
          Ask anything...
        </div>
      </div>
    </Shell>
  );
}

function HistoryScene() {
  const { sessions, activeSessionId, messages } = useAIContext();
  return (
    <Shell width={1440} height={900} className="flex">
      <ChatHistory
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewChat={() => undefined}
        onSwitchSession={() => undefined}
        onDeleteSession={() => undefined}
        onRenameSession={() => undefined}
        mode="view"
      />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-end gap-2 p-4">
          <button className="text-xs text-on-surface-muted px-2 py-1 rounded hover:bg-surface-tertiary">
            Hide
          </button>
          <button className="text-xs text-on-surface-muted px-2 py-1 rounded hover:bg-surface-tertiary">
            Clear
          </button>
        </div>
        <div className="flex-1 overflow-auto max-w-3xl mx-auto w-full px-4 py-6 space-y-4">
          {messages.length === 0 ? (
            <WelcomeScreen mode="view" onSend={() => undefined} isStreaming={false} />
          ) : (
            messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} mode="view" messageIndex={i} />
            ))
          )}
        </div>
      </div>
    </Shell>
  );
}

function MobileAiScene() {
  return (
    <Shell width={390} height={844} className="relative flex flex-col">
      <div className="flex-1 min-h-0">
        <AIChatNotConfigured
          onClose={() => undefined}
          onOpenSettings={() => undefined}
          isView={true}
        />
      </div>
      <BottomNavBar
        currentView="ai-chat"
        onNavigate={() => undefined}
        onMenuOpen={() => undefined}
        onOpenVoice={() => undefined}
        inboxCount={2}
        todayCount={3}
      />
    </Shell>
  );
}

function PttScene({ mode }: { mode: "listening" | "transcribing" | "error" }) {
  const voice = useVoiceContext();
  return (
    <Shell width={480} height={320} className="flex items-center justify-center p-8">
      <div className="rounded-xl border border-border bg-surface p-6 shadow-sm space-y-4 w-full max-w-sm">
        <p className="text-sm font-medium text-on-surface">Push-to-talk · {mode}</p>
        <div className="flex items-center gap-3 rounded-2xl bg-surface-secondary border border-border px-4 py-3">
          <span className="flex-1 text-sm text-on-surface-muted">Ask about your tasks...</span>
          <VoiceButton onResult={() => undefined} disabled={false} voice={voice} />
        </div>
      </div>
    </Shell>
  );
}

function VadGraceScene() {
  return (
    <Shell width={480} height={420} className="flex items-center justify-center p-8">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-4">
        <VoiceCallOverlay
          callState="listening"
          callDuration={42}
          onEndCall={() => undefined}
          isInGracePeriod={true}
          gracePeriodProgress={0.55}
        />
      </div>
    </Shell>
  );
}

function VoiceCallStatesScene() {
  const states = [
    { callState: "listening" as const, label: "listening", duration: 12 },
    { callState: "processing" as const, label: "processing", duration: 18 },
    { callState: "speaking" as const, label: "speaking", duration: 27 },
    {
      callState: "listening" as const,
      label: "recognition-error",
      duration: 33,
      error: "Microphone access was denied. Allow microphone access, then retry.",
    },
  ];
  return (
    <Shell width={1280} height={900} className="grid grid-cols-2 gap-6 p-8 bg-surface-secondary">
      {states.map((s) => (
        <div
          key={s.label}
          className="rounded-xl border border-border bg-surface p-4 flex flex-col items-center"
        >
          <p className="text-xs font-medium text-on-surface-muted mb-2 self-start">{s.label}</p>
          <VoiceCallOverlay
            callState={s.callState}
            callDuration={s.duration}
            onEndCall={() => undefined}
            recognitionError={s.error}
            onRetryRecognition={s.error ? () => undefined : undefined}
          />
        </div>
      ))}
    </Shell>
  );
}

function OnboardingScene() {
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
}

export function SceneRouter() {
  const fixture = readFixture();
  const scene = fixture.scene as Phase6SceneId;

  switch (scene) {
    case "ai-not-configured-panel-desktop-light":
      // AIChatNotConfigured already owns panel chrome when isView=false.
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
      return <ConversationScene />;
    case "ai-chat-history-desktop-light":
      return <HistoryScene />;
    case "ai-mobile-view-nav-light":
      return <MobileAiScene />;
    case "settings-ai-unconfigured-desktop-light":
      return (
        <SettingsChrome title="AI Assistant">
          <AITab />
        </SettingsChrome>
      );
    case "settings-ai-configured-masked-desktop-light":
      return (
        <SettingsChrome title="AI Assistant">
          <AITab />
        </SettingsChrome>
      );
    case "settings-voice-defaults-desktop-light":
      return (
        <SettingsChrome title="Voice">
          <VoiceTab />
        </SettingsChrome>
      );
    case "settings-voice-cloud-desktop-dark":
      return (
        <SettingsChrome title="Voice">
          <VoiceTab />
        </SettingsChrome>
      );
    case "ptt-listening-desktop-light":
      return <PttScene mode="listening" />;
    case "ptt-transcribing-desktop-light":
      return <PttScene mode="transcribing" />;
    case "ptt-error-desktop-light":
      return <PttScene mode="error" />;
    case "vad-grace-desktop-light":
      return <VadGraceScene />;
    case "voice-call-states-desktop-light":
      return <VoiceCallStatesScene />;
    case "focused-task-launch-desktop-light":
      return <ConversationScene focused />;
    case "onboarding-step-ai-desktop-light":
      return <OnboardingScene />;
    default:
      return (
        <Shell width={640} height={400} className="flex items-center justify-center">
          <p>Unknown scene: {scene}</p>
        </Shell>
      );
  }
}
