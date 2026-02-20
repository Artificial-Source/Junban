import { useState, useRef, useEffect, useCallback } from "react";
import {
  X,
  Send,
  Mic,
  Phone,
  Bot,
  Trash2,
  Settings,
  AlertTriangle,
  RotateCcw,
  Loader2,
  Volume2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAIContext } from "../context/AIContext.js";
import { useVoiceContext } from "../context/VoiceContext.js";
import { useVAD } from "../hooks/useVAD.js";
import { useVoiceCall } from "../hooks/useVoiceCall.js";
import { VoiceCallOverlay } from "./VoiceCallOverlay.js";
import { ChatTaskCard } from "./ChatTaskCard.js";
import { BrowserSTTProvider } from "../../ai/voice/adapters/browser-stt.js";
import { createAudioRecorder } from "../../ai/voice/audio-utils.js";
import type { AIChatMessage } from "../api/index.js";

interface AIChatPanelProps {
  onClose: () => void;
  onOpenSettings: () => void;
  onSelectTask?: (taskId: string) => void;
}

export function AIChatPanel({ onClose, onOpenSettings, onSelectTask }: AIChatPanelProps) {
  const {
    messages,
    isStreaming,
    isConfigured,
    sendMessage,
    clearChat,
    restoreMessages,
    retryLastMessage,
    setVoiceCallMode,
  } = useAIContext();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [restored, setRestored] = useState(false);

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

  // Focus input on mount and after streaming ends
  useEffect(() => {
    if (!isStreaming) {
      inputRef.current?.focus();
    }
  }, [isStreaming]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    await sendMessage(text);
  };

  const voice = useVoiceContext();
  const wasStreamingRef = useRef(false);

  const ttsAvailable = !!(voice.ttsProvider && voice.settings.ttsEnabled);
  console.log(
    "[VoiceCall:Panel] ttsAvailable:",
    ttsAvailable,
    "sttProvider:",
    voice.sttProvider?.id,
    "ttsProvider:",
    voice.ttsProvider?.id,
    "ttsEnabled:",
    voice.settings.ttsEnabled,
    "voiceMode:",
    voice.settings.voiceMode,
  );

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
      console.log(
        "[VoiceCall:Panel] handleVoiceResult:",
        JSON.stringify(cleaned),
        "callActive:",
        voiceCall.isCallActive,
      );
      // Filter out empty or non-speech markers from STT
      if (!cleaned || cleaned === "[BLANK_AUDIO]") {
        console.log("[VoiceCall:Panel] filtered out empty/blank transcript");
        return;
      }
      // During voice call, always auto-send
      if (voiceCall.isCallActive || voice.settings.autoSend) {
        console.log("[VoiceCall:Panel] auto-sending transcript to AI");
        sendMessage(cleaned);
      } else {
        setInput((prev) => (prev ? prev + " " + cleaned : cleaned));
      }
    },
    [voice.settings.autoSend, sendMessage, voiceCall.isCallActive],
  );

  // VAD integration — auto-detect speech and transcribe
  const handleVADSpeechEnd = useCallback(
    async (audio: Blob) => {
      console.log("[VoiceCall:Panel] VAD speech ended, audio size:", audio.size);
      try {
        const transcript = await voice.transcribeAudio(audio);
        console.log("[VoiceCall:Panel] VAD transcription result:", JSON.stringify(transcript));
        handleVoiceResult(transcript);
      } catch (err) {
        console.warn("[VoiceCall:Panel] VAD transcription failed:", err);
      }
    },
    [voice, handleVoiceResult],
  );

  // Voice call listening: prefer user's STT provider with VAD, fall back to browser STT
  const isNonBrowserSTT =
    voiceCall.isCallActive && !(voice.sttProvider instanceof BrowserSTTProvider);
  const browserSTTAvailable =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  // VAD enabled for: normal VAD mode outside calls, OR calls with API-based STT (Groq etc.)
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

  // Fall back to browser STT loop if: using browser STT provider, OR VAD failed to load
  const needBrowserSTTFallback =
    voiceCall.isCallActive &&
    (voice.sttProvider instanceof BrowserSTTProvider || (isNonBrowserSTT && !vad.isSupported));
  const useBrowserSTTLoop = needBrowserSTTFallback && browserSTTAvailable;

  console.log(
    "[VoiceCall:Panel] vadEnabled:",
    vadEnabled,
    "vad.isListening:",
    vad.isListening,
    "vad.isSupported:",
    vad.isSupported,
    "useBrowserSTTLoop:",
    useBrowserSTTLoop,
    "isNonBrowserSTT:",
    isNonBrowserSTT,
    "callState:",
    voiceCall.callState,
  );

  // Browser STT recognition loop — used for Browser STT provider, or as fallback when VAD fails
  const browserSTTRef = useRef<BrowserSTTProvider | null>(null);
  useEffect(() => {
    if (!browserSTTRef.current && browserSTTAvailable) {
      browserSTTRef.current = new BrowserSTTProvider();
    }
  }, [browserSTTAvailable]);

  useEffect(() => {
    if (!useBrowserSTTLoop || voiceCall.callState !== "listening") {
      if (voiceCall.isCallActive) {
        console.log(
          "[VoiceCall:Panel] Browser STT loop NOT starting — useBrowserSTTLoop:",
          useBrowserSTTLoop,
          "callState:",
          voiceCall.callState,
        );
      }
      return;
    }
    const stt = browserSTTRef.current;
    if (!stt) return;
    let cancelled = false;
    console.log(
      "[VoiceCall:Panel] Browser STT loop STARTING" + (isNonBrowserSTT ? " (VAD fallback)" : ""),
    );

    const listen = async () => {
      while (!cancelled) {
        try {
          const transcript = await stt.startLiveRecognition();
          if (cancelled) break;
          const cleaned = transcript.trim();
          if (cleaned && cleaned !== "[BLANK_AUDIO]") {
            console.log("[VoiceCall:Panel] Browser STT got:", JSON.stringify(cleaned));
            handleVoiceResult(cleaned);
            break;
          }
          // No speech detected — retry after brief pause
          await new Promise((r) => setTimeout(r, 200));
        } catch (err) {
          console.warn("[VoiceCall:Panel] Browser STT error:", err);
          if (cancelled) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    listen();

    return () => {
      cancelled = true;
    };
  }, [
    useBrowserSTTLoop,
    voiceCall.callState,
    handleVoiceResult,
    voiceCall.isCallActive,
    isNonBrowserSTT,
  ]);

  // Voice conversation loop: TTS when AI finishes responding (streaming → done)
  // Skip when voice call is active — the hook handles TTS
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;

    // Only trigger TTS when streaming just finished
    if (!wasStreaming || isStreaming) return;
    // Voice call hook handles its own TTS
    if (voiceCall.isCallActive) return;
    if (!voice.settings.ttsEnabled || voice.settings.voiceMode === "off") return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.content && !lastMsg.isError) {
      voice.speak(lastMsg.content).catch(() => {
        // TTS failed — silently ignore
      });
    }
  }, [isStreaming, messages, voice, voiceCall.isCallActive]);

  if (!isConfigured) {
    return (
      <aside className="w-full h-full md:w-80 md:h-auto border-l-0 md:border-l border-border flex flex-col bg-surface">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm text-on-surface">AI Chat</h3>
          <button
            onClick={onClose}
            aria-label="Close AI chat"
            className="text-on-surface-muted hover:text-on-surface-secondary transition-colors p-1 rounded-md hover:bg-surface-tertiary"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center mb-4">
            <Bot size={24} className="text-accent" />
          </div>
          <h4 className="font-medium text-sm text-on-surface mb-2">AI Assistant</h4>
          <p className="text-xs text-on-surface-muted mb-4">
            Configure an AI provider in Settings to start chatting.
          </p>
          <button
            onClick={onOpenSettings}
            className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors flex items-center gap-2"
          >
            <Settings size={14} />
            Open Settings
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-full h-full md:w-80 md:h-auto border-l-0 md:border-l border-border flex flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-sm text-on-surface flex items-center gap-2">
          <Bot size={16} className="text-accent" />
          AI Chat
        </h3>
        <div className="flex items-center gap-1">
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

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center mt-8 space-y-2">
            <p className="text-xs text-on-surface-muted">Ask me anything about your tasks!</p>
            <div className="flex flex-wrap gap-1.5 justify-center mt-3">
              {["What tasks do I have?", "Plan my day", "What's overdue?"].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => sendMessage(suggestion)}
                  disabled={isStreaming}
                  className="px-2 py-1 text-xs bg-surface-tertiary text-on-surface-secondary rounded-md hover:bg-border disabled:opacity-50 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
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
          />
        ))}
        {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex items-center gap-1.5 text-on-surface-muted text-sm">
            <span
              className="inline-block w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="inline-block w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="inline-block w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
              style={{ animationDelay: "300ms" }}
            />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input / Voice Call Overlay */}
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
        <form onSubmit={handleSubmit} className="p-3 border-t border-border">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your tasks..."
              className="min-w-0 flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <VoiceButton onResult={handleVoiceResult} disabled={isStreaming} voice={voice} />
            {voice.sttProvider && ttsAvailable && (
              <button
                type="button"
                onClick={voiceCall.startCall}
                disabled={isStreaming}
                title="Start voice call"
                className="shrink-0 px-2 py-2 text-sm rounded-lg border border-border text-on-surface-muted hover:bg-surface-secondary disabled:opacity-50 transition-colors"
              >
                <Phone size={16} />
              </button>
            )}
            <button
              type="submit"
              disabled={isStreaming || !input.trim()}
              className="shrink-0 px-3 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={16} />
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}

function getErrorHint(category?: string, message?: string): string | null {
  switch (category) {
    case "auth":
      return "Check your API key in Settings.";
    case "rate_limit":
      return "You've hit the rate limit. Wait a moment.";
    case "network":
      // The error message itself already has specific guidance for local providers
      if (message?.includes("LM Studio") || message?.includes("Ollama")) {
        return null;
      }
      return "Check your network connection and provider settings.";
    case "server":
      return "The provider is having issues. Try again in a moment.";
    case "timeout":
      return "The response took too long. Try a simpler question or check the provider.";
    default:
      return null;
  }
}

function extractTasksFromToolCalls(
  toolCalls?: AIChatMessage["toolCalls"],
): {
  id: string;
  title: string;
  status?: string;
  priority?: number | null;
  dueDate?: string | null;
}[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const tasks: {
    id: string;
    title: string;
    status?: string;
    priority?: number | null;
    dueDate?: string | null;
  }[] = [];
  const taskToolNames = new Set(["create_task", "update_task", "complete_task"]);

  for (const tc of toolCalls) {
    if (!taskToolNames.has(tc.name)) continue;
    try {
      const args = JSON.parse(tc.arguments);
      if (args.title || args.taskId) {
        tasks.push({
          id: args.taskId ?? "",
          title: args.title ?? tc.name.replace(/_/g, " "),
          priority: args.priority ?? null,
          dueDate: args.dueDate ?? null,
          status: tc.name === "complete_task" ? "completed" : "pending",
        });
      }
    } catch {
      /* skip */
    }
  }
  return tasks;
}

function MessageBubble({
  message,
  onRetry,
  onSelectTask,
}: {
  message: AIChatMessage;
  onRetry?: () => void;
  onSelectTask?: (taskId: string) => void;
}) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  // Don't render raw tool result messages
  if (isTool) return null;

  // Show tool call indicators for assistant messages that used tools
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  if (message.isError) {
    const hint = getErrorHint(message.errorCategory, message.content);
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] space-y-1">
          <div className="px-3 py-2 rounded-lg text-sm bg-error/10 border border-error/20 text-error">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p>{message.content}</p>
                {hint && <p className="text-xs mt-1 opacity-80">{hint}</p>}
              </div>
            </div>
            {onRetry && (
              <button
                onClick={onRetry}
                className="mt-2 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-error/10 hover:bg-error/20 transition-colors"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const inlineTasks = extractTasksFromToolCalls(message.toolCalls);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%] space-y-1">
        {hasToolCalls && (
          <div className="flex flex-wrap gap-1">
            {message.toolCalls!.map((tc) => (
              <ToolCallBadge key={tc.id} name={tc.name} args={tc.arguments} />
            ))}
          </div>
        )}
        {inlineTasks.length > 0 && onSelectTask && (
          <div className="space-y-1">
            {inlineTasks.map((task, i) => (
              <ChatTaskCard
                key={task.id || i}
                task={task}
                onClick={task.id ? onSelectTask : undefined}
              />
            ))}
          </div>
        )}
        {message.content && (
          <div
            className={`px-3 py-2 rounded-lg text-sm ${
              isUser ? "bg-accent text-white" : "bg-surface-tertiary text-on-surface"
            }`}
          >
            {isUser ? (
              <span className="whitespace-pre-wrap">{message.content}</span>
            ) : (
              <MarkdownMessage content={message.content} onSelectTask={onSelectTask} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownMessage({
  content,
  onSelectTask,
}: {
  content: string;
  onSelectTask?: (taskId: string) => void;
}) {
  const components = createMarkdownComponents(onSelectTask);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}

function createMarkdownComponents(onSelectTask?: (taskId: string) => void): Components {
  return {
    p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
    ol: ({ children }) => (
      <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>
    ),
    ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>,
    li: ({ children }) => <li className="pl-1">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    code: ({ children, className, ...props }) => {
      if (className) {
        return (
          <code {...props} className="block rounded-md bg-surface/70 px-2 py-1 font-mono text-xs">
            {children}
          </code>
        );
      }
      return (
        <code {...props} className="rounded bg-surface/70 px-1 py-0.5 font-mono text-xs">
          {children}
        </code>
      );
    },
    a: ({ href, children, ...props }) => {
      // Handle saydo://task/<id> links
      if (href && href.startsWith("saydo://task/") && onSelectTask) {
        const taskId = href.replace("saydo://task/", "");
        return (
          <button
            {...(props as any)}
            onClick={(e) => {
              e.preventDefault();
              onSelectTask(taskId);
            }}
            className="text-accent underline underline-offset-2 cursor-pointer"
          >
            {children}
          </button>
        );
      }
      return (
        <a
          {...props}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
  };
}

const TOOL_META: Record<string, { emoji: string; verb: string }> = {
  create_task: { emoji: "✨", verb: "Creating" },
  complete_task: { emoji: "✅", verb: "Completing" },
  update_task: { emoji: "✏️", verb: "Updating" },
  delete_task: { emoji: "🗑️", verb: "Deleting" },
  list_tasks: { emoji: "📋", verb: "Checking tasks" },
  query_tasks: { emoji: "🔍", verb: "Searching tasks" },
  list_tags: { emoji: "🏷️", verb: "Listing tags" },
  add_tags_to_task: { emoji: "🏷️", verb: "Adding tags" },
  remove_tags_from_task: { emoji: "🏷️", verb: "Removing tags" },
  create_project: { emoji: "📁", verb: "Creating project" },
  update_project: { emoji: "📁", verb: "Updating project" },
  delete_project: { emoji: "📁", verb: "Deleting project" },
};

function ToolCallBadge({ name, args }: { name: string; args: string }) {
  const meta = TOOL_META[name] ?? { emoji: "⚡", verb: name.replace(/_/g, " ") };
  let label = meta.verb;
  try {
    const parsed = JSON.parse(args);
    if (parsed.title) label = `${meta.verb} "${parsed.title}"`;
    else if (parsed.search) label = `Searching "${parsed.search}"`;
    else if (parsed.status) label = `${meta.verb} (${parsed.status})`;
  } catch {
    // Use default label
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-accent/10 text-accent rounded-full">
      <span>{meta.emoji}</span>
      {label}
    </span>
  );
}

function VoiceButton({
  onResult,
  disabled,
  voice,
}: {
  onResult: (text: string) => void;
  disabled: boolean;
  voice: ReturnType<typeof useVoiceContext>;
}) {
  const [listening, setListening] = useState(false);
  const recorderRef = useRef<ReturnType<typeof createAudioRecorder> | null>(null);

  const { settings, sttProvider, isTranscribing, isSpeaking } = voice;

  const handlePushToTalk = useCallback(async () => {
    if (listening) {
      // Stop recording and transcribe
      setListening(false);
      if (sttProvider instanceof BrowserSTTProvider) {
        // Browser STT handles its own recording — the result comes from the recognition event
        return;
      }
      // For API-based STT (Groq), stop the recorder and transcribe the blob
      if (recorderRef.current) {
        try {
          const blob = await recorderRef.current.stop();
          const transcript = await voice.transcribeAudio(blob);
          onResult(transcript);
        } catch {
          // Transcription failed
        }
        recorderRef.current = null;
      }
      return;
    }

    // Start recording
    setListening(true);
    if (sttProvider instanceof BrowserSTTProvider) {
      // Use browser live recognition
      try {
        const transcript = await sttProvider.startLiveRecognition();
        if (transcript) onResult(transcript);
      } catch {
        // Recognition failed
      }
      setListening(false);
    } else {
      // Use MediaRecorder for API-based STT
      const recorder = createAudioRecorder(voice.settings.microphoneId || undefined);
      recorderRef.current = recorder;
      try {
        await recorder.start();
      } catch {
        setListening(false);
        recorderRef.current = null;
      }
    }
  }, [listening, sttProvider, voice, onResult]);

  // Don't show button if voice mode is off or VAD (VAD handles itself)
  if (settings.voiceMode === "off" || settings.voiceMode === "vad") return null;

  const buttonState = isTranscribing
    ? "transcribing"
    : isSpeaking
      ? "speaking"
      : listening
        ? "listening"
        : "idle";

  const title = {
    idle: "Voice input (push to talk)",
    listening: "Stop listening",
    transcribing: "Transcribing...",
    speaking: "AI speaking...",
  }[buttonState];

  const icon = {
    idle: <Mic size={16} />,
    listening: <Mic size={16} />,
    transcribing: <Loader2 size={16} className="animate-spin" />,
    speaking: <Volume2 size={16} className="animate-pulse" />,
  }[buttonState];

  const colorClass = {
    idle: "border-border text-on-surface-muted hover:bg-surface-secondary",
    listening:
      "bg-error/20 border-error text-error animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.4)]",
    transcribing: "bg-accent/10 border-accent/30 text-accent",
    speaking: "bg-success/10 border-success/30 text-success",
  }[buttonState];

  return (
    <button
      type="button"
      onClick={handlePushToTalk}
      disabled={disabled || isTranscribing}
      title={title}
      className={`shrink-0 px-2 py-2 text-sm rounded-lg border disabled:opacity-50 transition-colors ${colorClass}`}
    >
      {icon}
    </button>
  );
}
