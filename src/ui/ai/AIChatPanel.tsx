/**
 * Configured AI chat panel (view mode) — legacy presentation hierarchy.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  ChatHistory,
  ChatInput,
  MessageBubble,
  SuggestedActions,
  TypingIndicator,
  WelcomeScreen,
  type ChatInputRef,
  type WelcomeStats,
} from "./chat";
import { AiOnboarding } from "./AiOnboarding";
import { dismissAiOnboarding, isAiOnboardingDismissed } from "./onboarding-dismissal";
import { useAiConversation, type UseAiConversationOptions } from "./useAiConversation";
import type { ChatMessageView, ChatSessionView } from "./message-view";
import type { VoiceSettingsDto } from "./types";
import {
  VoiceCallOverlay,
  useVoiceController,
  type LocalSttAdapter,
  type LocalTtsAdapter,
  type VoiceFixture,
  type VoiceCallPresentationState,
} from "../voice";

export type AIChatPanelFixture = {
  forceOnboarding?: boolean;
  forceWelcome?: boolean;
  forceHistoryOpen?: boolean;
  forceMobile?: boolean;
  messages?: ChatMessageView[];
  /** Explicit session list for history scenes (no network). */
  sessions?: ChatSessionView[];
  activeSessionId?: string | null;
  stats?: WelcomeStats;
  greetingOverride?: string;
  timeOfDayOverride?: "morning" | "afternoon" | "evening" | "night";
  focusedTaskTitle?: string | null;
  dailyBriefingEnabled?: boolean;
  /** Explicit voice fixture for immutable scenes 10–14. */
  voice?: VoiceFixture;
  /** Panel chrome mode for component-sized harness scenes. */
  mode?: "panel" | "view";
  /** Hide floating history/clear chrome (harness provides its own). */
  hideFloatingActions?: boolean;
};

export interface AIChatPanelProps {
  onOpenSettings: () => void;
  onOpenVoiceSettings?: () => void;
  onSelectTask?: (taskId: string) => void;
  focusedTaskId?: string | null;
  focusedTaskTitle?: string | null;
  dailyBriefingEnabled?: boolean;
  autoSend?: boolean;
  /** Concrete prompt from launch query; only auto-sent when autoSend is true. */
  launchPrompt?: string | null;
  welcomeStats?: WelcomeStats;
  /** Server-confirmed voice settings (never draft). */
  voiceSettings?: VoiceSettingsDto | null;
  /** Injected local adapters from the route hook (null when browser/cloud). */
  localStt?: LocalSttAdapter | null;
  localTts?: LocalTtsAdapter | null;
  conversationOptions?: Omit<UseAiConversationOptions, "focusedTaskId" | "enabled">;
  /** Explicit fixture view-model only — production must not pass this. */
  fixture?: AIChatPanelFixture;
}

const DEFAULT_VOICE_SETTINGS: VoiceSettingsDto = {
  cloud_speech_enabled: false,
  grace_period_ms: 1000,
  stt_provider: "browser",
  stt_model: null,
  tts_provider: "browser",
  tts_model: null,
  tts_voice: null,
  stt_credential_id: null,
  tts_credential_id: null,
  tts_enabled: false,
  voice_mode: "push_to_talk",
};

export function AIChatPanel({
  onOpenSettings,
  onOpenVoiceSettings,
  onSelectTask,
  focusedTaskId = null,
  focusedTaskTitle = null,
  dailyBriefingEnabled = false,
  autoSend = false,
  launchPrompt = null,
  welcomeStats,
  voiceSettings = null,
  localStt = null,
  localTts = null,
  conversationOptions,
  fixture,
}: AIChatPanelProps) {
  // Any fixture view-model disables conversation + local-voice side effects,
  // not only fixtures that inject messages (prevents partial fixture leaks).
  const fixtureActive = Boolean(fixture);
  const conversation = useAiConversation({
    ...conversationOptions,
    focusedTaskId,
    enabled: !fixtureActive,
  });

  const chatInputRef = useRef<ChatInputRef>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const launchHandledRef = useRef(false);
  const [showHistory, setShowHistory] = useState(Boolean(fixture?.forceHistoryOpen));
  const [onboardingVisible, setOnboardingVisible] = useState(() => {
    if (fixture?.forceOnboarding) return true;
    if (fixture) return false;
    return !isAiOnboardingDismissed();
  });

  const messages = fixture?.messages ?? conversation.messages;
  const isStreaming = fixtureActive ? false : conversation.isStreaming;
  const sessions = fixture?.sessions ?? conversation.sessions;
  const activeSessionId = fixture?.activeSessionId ?? conversation.activeSessionId;
  const stats = fixture?.stats ?? welcomeStats;
  const briefingEnabled = fixture?.dailyBriefingEnabled ?? dailyBriefingEnabled;
  const taskTitle = fixture?.focusedTaskTitle ?? focusedTaskTitle;
  const confirmedVoice = voiceSettings ?? DEFAULT_VOICE_SETTINGS;
  const chatMode = fixture?.mode ?? "view";
  const noop = () => undefined;

  const voice = useVoiceController({
    settings: confirmedVoice,
    autoSend,
    messages,
    isStreaming,
    activeSessionId,
    sendMessage: (text) => {
      void conversation.sendMessage(text);
    },
    stopConversation: () => conversation.stop(),
    enabled: !fixtureActive,
    fixture: fixture?.voice ?? null,
    localStt: fixtureActive ? null : localStt,
    localTts: fixtureActive ? null : localTts,
  });

  // Focused-task launch: prefill always; auto-send only with a concrete prompt.
  useEffect(() => {
    if (fixture || launchHandledRef.current) return;
    if (!focusedTaskId && !launchPrompt) return;
    launchHandledRef.current = true;

    const prefill =
      launchPrompt?.trim() || (taskTitle ? `Help me with: ${taskTitle}` : "Help me with this task");

    if (autoSend && launchPrompt?.trim()) {
      void conversation.sendMessage(launchPrompt.trim());
    } else {
      conversation.setComposerPrefill(prefill);
      chatInputRef.current?.setValue(prefill);
    }
  }, [autoSend, conversation, fixture, focusedTaskId, launchPrompt, taskTitle]);

  // Auto-scroll on new messages (respect reduced motion via CSS scroll-behavior).
  useEffect(() => {
    const node = messagesEndRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, isStreaming]);

  useEffect(() => {
    if (!isStreaming) chatInputRef.current?.focus();
  }, [isStreaming]);

  const handleSubmit = useCallback(
    (text: string) => {
      void conversation.sendMessage(text);
    },
    [conversation],
  );

  const handleDismissOnboarding = useCallback(() => {
    dismissAiOnboarding();
    setOnboardingVisible(false);
  }, []);

  const showWelcome =
    fixture?.forceWelcome ||
    (messages.length === 0 && (fixtureActive || !conversation.messagesLoading));

  const isMobileLayout = Boolean(fixture?.forceMobile);

  return (
    <aside
      className={`w-full h-full flex bg-surface relative pb-[var(--height-bottom-nav)] md:pb-0 ${
        isMobileLayout ? "flex-col" : ""
      }`}
      aria-label="AI chat"
    >
      {showHistory && sessions.length > 0 && (
        <ChatHistory
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewChat={fixtureActive ? noop : conversation.createNewSession}
          onSwitchSession={
            fixtureActive
              ? noop
              : (id) => {
                  void conversation.selectSession(id);
                }
          }
          onDeleteSession={
            fixtureActive
              ? noop
              : (id) => {
                  void conversation.deleteSession(id);
                }
          }
          onRenameSession={
            fixtureActive
              ? noop
              : (id, title) => {
                  void conversation.renameSession(id, title);
                }
          }
          mode={chatMode === "panel" ? "panel" : "view"}
          onLoadMore={
            fixtureActive
              ? undefined
              : () => {
                  void conversation.loadMoreSessions();
                }
          }
          hasMore={fixtureActive ? false : Boolean(conversation.sessionsCursor)}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {onboardingVisible && (
          <AiOnboarding
            onConfigureAi={() => {
              handleDismissOnboarding();
              onOpenSettings();
            }}
            onSetupVoice={() => {
              handleDismissOnboarding();
              (onOpenVoiceSettings ?? onOpenSettings)();
            }}
            onDismiss={handleDismissOnboarding}
          />
        )}

        {/* Floating actions */}
        {!fixture?.hideFloatingActions && (
          <div className="absolute top-4 right-4 z-10 flex items-center gap-1">
            {(sessions.length > 0 || fixture?.forceHistoryOpen) && (
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                title="Chat history"
                aria-label={showHistory ? "Hide chat history" : "Show chat history"}
                aria-pressed={showHistory}
                className="text-on-surface-muted hover:text-on-surface-secondary p-2 rounded-lg hover:bg-surface-tertiary transition-colors text-xs"
              >
                {showHistory ? "Hide" : "History"}
              </button>
            )}
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (!fixtureActive) void conversation.clearSession();
                }}
                title="Clear chat"
                aria-label="Clear chat"
                className="text-on-surface-muted hover:text-on-surface-secondary p-2 rounded-lg hover:bg-surface-tertiary transition-colors"
              >
                <Trash2 size={18} aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {taskTitle && (
          <div
            className="mx-4 mt-3 px-3 py-2 rounded-lg bg-accent-action/10 text-xs text-accent-foreground border border-accent-action/20"
            role="status"
          >
            Focused task: <span className="font-medium">{taskTitle}</span>
          </div>
        )}

        {conversation.error && (
          <div
            role="alert"
            aria-live="assertive"
            className="mx-4 mt-3 px-3 py-2 rounded-lg bg-error/10 border border-error/20 text-error text-xs flex items-start justify-between gap-2"
          >
            <span>{conversation.error.message}</span>
            <button
              type="button"
              onClick={conversation.dismissError}
              className="shrink-0 underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {showWelcome ? (
          <WelcomeScreen
            mode={chatMode}
            onSend={handleSubmit}
            onDailyBriefing={() => {
              if (!fixtureActive) void conversation.sendDailyBriefing();
            }}
            isStreaming={isStreaming}
            stats={stats}
            dailyBriefingEnabled={briefingEnabled}
            greetingOverride={fixture?.greetingOverride}
            timeOfDayOverride={fixture?.timeOfDayOverride}
          />
        ) : (
          <div className="flex-1 overflow-auto">
            <div
              className={
                chatMode === "panel"
                  ? "px-3 py-3 space-y-3"
                  : "max-w-3xl mx-auto px-4 py-6 space-y-4"
              }
            >
              {messages.map((msg, i) => {
                const isLast = i === messages.length - 1;
                return (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onRetry={
                      !fixtureActive && msg.isError && msg.retryable && isLast
                        ? () => {
                            void conversation.retryMessage(msg.id);
                          }
                        : undefined
                    }
                    onSelectTask={onSelectTask}
                    isLatest={isLast}
                    isStreaming={isStreaming}
                    mode={chatMode}
                    onEditAndResend={
                      fixtureActive
                        ? undefined
                        : (id, text) => {
                            void conversation.editAndResend(id, text);
                          }
                    }
                    onRegenerate={
                      !fixtureActive && msg.role === "assistant" && isLast && !isStreaming
                        ? () => {
                            void conversation.regenerateMessage(msg.id);
                          }
                        : undefined
                    }
                    onApprove={
                      fixtureActive
                        ? undefined
                        : (approvalId, actionHash) => {
                            void conversation.approveProposal(approvalId, actionHash);
                          }
                    }
                    onReject={
                      fixtureActive
                        ? undefined
                        : (approvalId, actionHash) => {
                            void conversation.rejectProposal(approvalId, actionHash);
                          }
                    }
                  />
                );
              })}
              {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
                <TypingIndicator mode={chatMode} status={conversation.reasoningStatus} />
              )}
              {!fixtureActive && !isStreaming && messages.length > 0 && (
                <SuggestedActions
                  messages={messages}
                  onSend={handleSubmit}
                  isStreaming={isStreaming}
                />
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {voice.isCallActive ? (
          <div className="max-w-3xl mx-auto w-full px-4 pb-6">
            <VoiceCallOverlay
              callState={
                (voice.callState === "idle"
                  ? "listening"
                  : voice.callState) as VoiceCallPresentationState
              }
              callDuration={voice.callDuration}
              onEndCall={voice.endCall}
              isInGracePeriod={voice.isInGracePeriod}
              gracePeriodProgress={voice.gracePeriodProgress}
              recognitionError={voice.recognitionError}
              onRetryRecognition={voice.retryRecognition}
            />
          </div>
        ) : (
          <ChatInput
            ref={chatInputRef}
            onSubmit={handleSubmit}
            onStop={() => {
              voice.stop();
            }}
            isStreaming={isStreaming}
            mode={chatMode}
            prefill={conversation.composerPrefill}
            voice={{
              buttonState: voice.buttonState,
              onTogglePtt: voice.togglePushToTalk,
              permissionError: voice.recognitionError,
              error: voice.error,
              onRetryPermission: voice.retryRecognition,
              showPttButton: voice.showPttButton,
              showCallButton: fixtureActive ? false : voice.showCallButton,
              onStartCall: voice.startCall,
            }}
          />
        )}
      </div>
    </aside>
  );
}
