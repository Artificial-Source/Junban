import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { X, Bot, Trash2 } from "lucide-react";
import { useReducedMotion } from "./useReducedMotion.js";
import { slideInRight } from "../utils/animation-variants.js";
import { useAIContext } from "../context/AIContext.js";
import { VoiceCallOverlay } from "./VoiceCallOverlay.js";
import {
  MessageBubble,
  TypingIndicator,
  ChatInput,
  WelcomeScreen,
  SuggestedActions,
  ChatHistory,
} from "./chat/index.js";
import type { ChatInputRef } from "./chat/index.js";
import { useAIChatVoice } from "./chat/useAIChatVoice.js";
import { AIChatNotConfigured } from "./chat/AIChatNotConfigured.js";

interface AIChatPanelProps {
  onClose: () => void;
  onOpenSettings: () => void;
  onSelectTask?: (taskId: string) => void;
  focusedTaskId?: string | null;
  mode?: "panel" | "view";
}

export function AIChatPanel({
  onClose,
  onOpenSettings,
  onSelectTask,
  focusedTaskId,
  mode = "panel",
}: AIChatPanelProps) {
  const isView = mode === "view";
  const {
    messages,
    isStreaming,
    isConfigured,
    sendMessage,
    clearChat,
    restoreMessages,
    retryLastMessage,
    setVoiceCallMode,
    editAndResend,
    regenerateLastResponse,
    sessions,
    activeSessionId,
    createNewSession,
    switchSession,
    deleteSession,
    renameSession,
    setFocusedTaskId,
  } = useAIContext();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const [restored, setRestored] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [lastKnownMessageCount, setLastKnownMessageCount] = useState(0);

  useEffect(() => {
    setFocusedTaskId(focusedTaskId ?? null);
    return () => {
      setFocusedTaskId(null);
    };
  }, [focusedTaskId, setFocusedTaskId]);

  // Restore chat history on first open
  useEffect(() => {
    if (!restored && isConfigured) {
      restoreMessages();
      setRestored(true);
    }
  }, [restored, isConfigured, restoreMessages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input after streaming ends
  useEffect(() => {
    if (!isStreaming) {
      chatInputRef.current?.focus();
    }
  }, [isStreaming]);

  // Track whether a new message was added (for entrance animation)
  useEffect(() => {
    setLastKnownMessageCount(messages.length);
  }, [messages.length]);

  const { voice, voiceCall, vad, handleVoiceResult, ttsAvailable, showCallButton } = useAIChatVoice(
    {
      isStreaming,
      messages,
      sendMessage,
      setVoiceCallMode,
    },
  );

  const handleSubmit = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  const reducedMotion = useReducedMotion();
  const isNewMessage = messages.length > lastKnownMessageCount;

  // ── Not Configured State ──
  if (!isConfigured) {
    return (
      <AIChatNotConfigured onClose={onClose} onOpenSettings={onOpenSettings} isView={isView} />
    );
  }

  // ── View Mode ──
  if (isView) {
    return (
      <aside className="w-full h-full flex bg-surface relative pb-[var(--height-bottom-nav)] md:pb-0">
        {/* Chat History sidebar */}
        {showHistory && sessions.length > 0 && (
          <ChatHistory
            sessions={sessions}
            activeSessionId={activeSessionId}
            onNewChat={createNewSession}
            onSwitchSession={switchSession}
            onDeleteSession={deleteSession}
            onRenameSession={renameSession}
            mode="view"
          />
        )}

        <div className="flex-1 flex flex-col min-w-0">
          {/* Floating actions */}
          <div className="absolute top-4 right-4 z-10 flex items-center gap-1">
            {sessions.length > 0 && (
              <button
                onClick={() => setShowHistory(!showHistory)}
                title="Chat history"
                className="text-on-surface-muted hover:text-on-surface-secondary p-2 rounded-lg hover:bg-surface-tertiary transition-colors text-xs"
              >
                {showHistory ? "Hide" : "History"}
              </button>
            )}
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                title="Clear chat"
                className="text-on-surface-muted hover:text-on-surface-secondary p-2 rounded-lg hover:bg-surface-tertiary transition-colors"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>

          {/* Messages / Empty state */}
          {messages.length === 0 ? (
            <WelcomeScreen mode="view" onSend={handleSubmit} isStreaming={isStreaming} />
          ) : (
            <div className="flex-1 overflow-auto">
              <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
                {messages.map((msg, i) => (
                  <MessageBubble
                    key={i}
                    message={msg}
                    onRetry={
                      msg.isError && msg.retryable && i === messages.length - 1
                        ? retryLastMessage
                        : undefined
                    }
                    onSelectTask={onSelectTask}
                    isLatest={i === messages.length - 1 && isNewMessage}
                    isStreaming={isStreaming}
                    mode="view"
                    messageIndex={i}
                    onEditAndResend={msg.role === "user" ? editAndResend : undefined}
                    onRegenerate={
                      msg.role === "assistant" && i === messages.length - 1 && !isStreaming
                        ? regenerateLastResponse
                        : undefined
                    }
                  />
                ))}
                {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
                  <TypingIndicator mode="view" />
                )}
                {!isStreaming && messages.length > 0 && (
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

          {/* Input */}
          {voiceCall.isCallActive ? (
            <div className="max-w-3xl mx-auto w-full px-4 pb-6">
              <VoiceCallOverlay
                callState={voiceCall.callState as Exclude<typeof voiceCall.callState, "idle">}
                callDuration={voiceCall.callDuration}
                onEndCall={voiceCall.endCall}
                isInGracePeriod={vad.isInGracePeriod}
                gracePeriodProgress={vad.gracePeriodProgress}
              />
            </div>
          ) : (
            <ChatInput
              ref={chatInputRef}
              onSubmit={handleSubmit}
              isStreaming={isStreaming}
              mode="view"
              voice={voice}
              ttsAvailable={ttsAvailable}
              onVoiceResult={handleVoiceResult}
              onStartCall={voiceCall.startCall}
              showCallButton={showCallButton}
            />
          )}
        </div>
      </aside>
    );
  }

  // ── Panel Mode ──
  const PanelWrapper = reducedMotion ? "aside" : motion.aside;
  const panelMotionProps = reducedMotion
    ? {}
    : {
        variants: slideInRight,
        initial: "initial" as const,
        animate: "animate" as const,
        exit: "exit" as const,
      };
  return (
    <PanelWrapper
      className="w-full h-full pb-[var(--height-bottom-nav)] md:pb-0 md:w-80 md:h-auto border-l-0 md:border-l border-border flex flex-col bg-surface"
      {...panelMotionProps}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-sm text-on-surface flex items-center gap-2">
          <Bot size={16} className="text-accent" />
          AI Chat
        </h3>
        <div className="flex items-center gap-1">
          {sessions.length > 0 && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              title="Chat history"
              className="text-on-surface-muted hover:text-on-surface-secondary p-1 rounded-md hover:bg-surface-tertiary transition-colors text-[10px]"
            >
              {showHistory ? "Hide" : "History"}
            </button>
          )}
          <button
            onClick={clearChat}
            title="Clear chat"
            className="text-on-surface-muted hover:text-on-surface-secondary p-1 rounded-md hover:bg-surface-tertiary transition-colors"
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={onClose}
            aria-label="Close AI chat"
            className="text-on-surface-muted hover:text-on-surface-secondary p-1 rounded-md hover:bg-surface-tertiary transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Chat History dropdown */}
      {showHistory && sessions.length > 0 && (
        <ChatHistory
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewChat={createNewSession}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          onRenameSession={renameSession}
          mode="panel"
        />
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto px-3 py-3 md:p-4 space-y-3">
        {messages.length === 0 && (
          <WelcomeScreen mode="panel" onSend={handleSubmit} isStreaming={isStreaming} />
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            message={msg}
            onRetry={
              msg.isError && msg.retryable && i === messages.length - 1
                ? retryLastMessage
                : undefined
            }
            onSelectTask={onSelectTask}
            isLatest={i === messages.length - 1 && isNewMessage}
            isStreaming={isStreaming}
            mode="panel"
            messageIndex={i}
            onEditAndResend={msg.role === "user" ? editAndResend : undefined}
            onRegenerate={
              msg.role === "assistant" && i === messages.length - 1 && !isStreaming
                ? regenerateLastResponse
                : undefined
            }
          />
        ))}
        {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
          <TypingIndicator mode="panel" />
        )}
        {!isStreaming && messages.length > 0 && (
          <SuggestedActions messages={messages} onSend={handleSubmit} isStreaming={isStreaming} />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {voiceCall.isCallActive ? (
        <div className="p-3 border-t border-border">
          <VoiceCallOverlay
            callState={voiceCall.callState as Exclude<typeof voiceCall.callState, "idle">}
            callDuration={voiceCall.callDuration}
            onEndCall={voiceCall.endCall}
            isInGracePeriod={vad.isInGracePeriod}
            gracePeriodProgress={vad.gracePeriodProgress}
          />
        </div>
      ) : (
        <ChatInput
          ref={chatInputRef}
          onSubmit={handleSubmit}
          isStreaming={isStreaming}
          mode="panel"
          voice={voice}
          ttsAvailable={ttsAvailable}
          onVoiceResult={handleVoiceResult}
          onStartCall={voiceCall.startCall}
          showCallButton={showCallButton}
        />
      )}
    </PanelWrapper>
  );
}
