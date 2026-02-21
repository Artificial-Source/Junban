import { useState, useRef, useEffect, useCallback } from "react";
import { X, Bot, Settings, Trash2 } from "lucide-react";
import { useAIContext } from "../context/AIContext.js";
import { useVoiceContext } from "../context/VoiceContext.js";
import { useVAD } from "../hooks/useVAD.js";
import { useVoiceCall } from "../hooks/useVoiceCall.js";
import { VoiceCallOverlay } from "./VoiceCallOverlay.js";
import { BrowserSTTProvider } from "../../ai/voice/adapters/browser-stt.js";
import {
  MessageBubble,
  TypingIndicator,
  ChatInput,
  WelcomeScreen,
  SuggestedActions,
  ChatHistory,
} from "./chat/index.js";
import type { ChatInputRef } from "./chat/index.js";

interface AIChatPanelProps {
  onClose: () => void;
  onOpenSettings: () => void;
  onSelectTask?: (taskId: string) => void;
  mode?: "panel" | "view";
}

export function AIChatPanel({ onClose, onOpenSettings, onSelectTask, mode = "panel" }: AIChatPanelProps) {
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
  } = useAIContext();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const [restored, setRestored] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [lastKnownMessageCount, setLastKnownMessageCount] = useState(0);

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

  const voice = useVoiceContext();
  const wasStreamingRef = useRef(false);

  const ttsAvailable = !!(voice.ttsProvider && voice.settings.ttsEnabled);

  const voiceCall = useVoiceCall({
    speak: voice.speak,
    cancelSpeech: voice.cancelSpeech,
    isSpeaking: voice.isSpeaking,
    isStreaming,
    messages,
    ttsAvailable,
    setVoiceCallMode,
  });

  const handleVoiceResult = useCallback(
    (transcript: string) => {
      const cleaned = transcript.trim();
      if (!cleaned || cleaned === "[BLANK_AUDIO]") return;
      if (voiceCall.isCallActive || voice.settings.autoSend) {
        sendMessage(cleaned);
      } else {
        // Append to input — handled via ChatInput's own state
      }
    },
    [voice.settings.autoSend, sendMessage, voiceCall.isCallActive],
  );

  // VAD integration
  const handleVADSpeechEnd = useCallback(
    async (audio: Blob) => {
      try {
        const transcript = await voice.transcribeAudio(audio);
        handleVoiceResult(transcript);
      } catch {
        // VAD transcription failed
      }
    },
    [voice, handleVoiceResult],
  );

  const isNonBrowserSTT =
    voiceCall.isCallActive && !(voice.sttProvider instanceof BrowserSTTProvider);
  const browserSTTAvailable =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const vadEnabled =
    (voice.settings.voiceMode === "vad" &&
      !isStreaming &&
      !voice.isSpeaking &&
      !voiceCall.isCallActive) ||
    (voiceCall.vadEnabled && isNonBrowserSTT);

  const vad = useVAD({
    onSpeechEnd: handleVADSpeechEnd,
    enabled: vadEnabled,
    deviceId: voice.settings.microphoneId || undefined,
    smartEndpoint: voice.settings.smartEndpoint,
    gracePeriodMs: voice.settings.gracePeriodMs,
  });

  const needBrowserSTTFallback =
    voiceCall.isCallActive &&
    (voice.sttProvider instanceof BrowserSTTProvider || (isNonBrowserSTT && !vad.isSupported));
  const useBrowserSTTLoop = needBrowserSTTFallback && browserSTTAvailable;

  // Browser STT recognition loop
  const browserSTTRef = useRef<BrowserSTTProvider | null>(null);
  useEffect(() => {
    if (!browserSTTRef.current && browserSTTAvailable) {
      browserSTTRef.current = new BrowserSTTProvider();
    }
  }, [browserSTTAvailable]);

  useEffect(() => {
    if (!useBrowserSTTLoop || voiceCall.callState !== "listening") return;
    const stt = browserSTTRef.current;
    if (!stt) return;
    let cancelled = false;

    const listen = async () => {
      while (!cancelled) {
        try {
          const transcript = await stt.startLiveRecognition();
          if (cancelled) break;
          const cleaned = transcript.trim();
          if (cleaned && cleaned !== "[BLANK_AUDIO]") {
            handleVoiceResult(cleaned);
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          if (cancelled) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    listen();
    return () => { cancelled = true; };
  }, [useBrowserSTTLoop, voiceCall.callState, handleVoiceResult, voiceCall.isCallActive, isNonBrowserSTT]);

  // TTS when AI finishes responding
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;
    if (voiceCall.isCallActive) return;
    if (!voice.settings.ttsEnabled || voice.settings.voiceMode === "off") return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.content && !lastMsg.isError) {
      voice.speak(lastMsg.content).catch(() => {});
    }
  }, [isStreaming, messages, voice, voiceCall.isCallActive]);

  const handleSubmit = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  const showCallButton = !!(voice.sttProvider && ttsAvailable);
  const isNewMessage = messages.length > lastKnownMessageCount;

  // ── Not Configured State ──
  if (!isConfigured) {
    return (
      <aside className={`${isView ? "w-full h-full" : "w-full h-full md:w-80 md:h-auto border-l-0 md:border-l border-border"} flex flex-col bg-surface`}>
        {!isView && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-sm text-on-surface">AI Chat</h3>
            <button onClick={onClose} aria-label="Close AI chat" className="text-on-surface-muted hover:text-on-surface-secondary transition-colors p-1 rounded-md hover:bg-surface-tertiary">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className={`${isView ? "w-16 h-16 mb-6" : "w-12 h-12 mb-4"} rounded-full bg-accent/10 flex items-center justify-center`}>
            <Bot size={isView ? 32 : 24} className="text-accent" />
          </div>
          <h4 className={`font-medium ${isView ? "text-lg mb-2" : "text-sm mb-2"} text-on-surface`}>AI Assistant</h4>
          <p className={`${isView ? "text-sm mb-6 max-w-md" : "text-xs mb-4"} text-on-surface-muted`}>
            Configure an AI provider in Settings to start chatting.
          </p>
          <button
            onClick={onOpenSettings}
            className={`${isView ? "px-5 py-2.5" : "px-4 py-2"} text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors flex items-center gap-2`}
          >
            <Settings size={isView ? 16 : 14} />
            Open Settings
          </button>
        </div>
      </aside>
    );
  }

  // ── View Mode ──
  if (isView) {
    return (
      <aside className="w-full h-full flex bg-surface relative">
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
                  <SuggestedActions messages={messages} onSend={handleSubmit} isStreaming={isStreaming} />
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
  return (
    <aside className="w-full h-full md:w-80 md:h-auto border-l-0 md:border-l border-border flex flex-col bg-surface">
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
      <div className="flex-1 overflow-auto p-4 space-y-3">
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
    </aside>
  );
}
