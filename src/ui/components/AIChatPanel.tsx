import { useState, useRef, useEffect, useCallback } from "react";
import { X, Send, Mic, MicOff, Bot, Trash2, Settings, AlertTriangle, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAIContext } from "../context/AIContext.js";
import type { AIChatMessage } from "../api.js";

interface AIChatPanelProps {
  onClose: () => void;
  onOpenSettings: () => void;
}

export function AIChatPanel({ onClose, onOpenSettings }: AIChatPanelProps) {
  const {
    messages,
    isStreaming,
    isConfigured,
    sendMessage,
    clearChat,
    restoreMessages,
    retryLastMessage,
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

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    await sendMessage(text);
  };

  const handleVoiceResult = useCallback((transcript: string) => {
    setInput((prev) => (prev ? prev + " " + transcript : transcript));
  }, []);

  if (!isConfigured) {
    return (
      <aside className="w-80 border-l border-border flex flex-col bg-surface">
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
    <aside className="w-80 border-l border-border flex flex-col bg-surface">
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

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-border">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your tasks..."
            disabled={isStreaming}
            className="min-w-0 flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
          <VoiceButton onResult={handleVoiceResult} disabled={isStreaming} />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="shrink-0 px-3 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </aside>
  );
}

function getErrorHint(category?: string): string | null {
  switch (category) {
    case "auth":
      return "Check your API key in Settings.";
    case "rate_limit":
      return "You've hit the rate limit. Wait a moment.";
    case "network":
      return "Check your network connection.";
    case "server":
      return "The provider is having issues.";
    case "timeout":
      return "The response took too long.";
    default:
      return null;
  }
}

function MessageBubble({
  message,
  onRetry,
}: {
  message: AIChatMessage;
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  // Don't render raw tool result messages
  if (isTool) return null;

  // Show tool call indicators for assistant messages that used tools
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  if (message.isError) {
    const hint = getErrorHint(message.errorCategory);
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
        {message.content && (
          <div
            className={`px-3 py-2 rounded-lg text-sm ${
              isUser ? "bg-accent text-white" : "bg-surface-tertiary text-on-surface"
            }`}
          >
            {isUser ? (
              <span className="whitespace-pre-wrap">{message.content}</span>
            ) : (
              <MarkdownMessage content={message.content} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>,
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
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline underline-offset-2"
    >
      {children}
    </a>
  ),
};

function ToolCallBadge({ name, args }: { name: string; args: string }) {
  let label = name.replace(/_/g, " ");
  try {
    const parsed = JSON.parse(args);
    if (parsed.title) label = `${name === "create_task" ? "Creating" : "Task"}: ${parsed.title}`;
    else if (parsed.taskId) label = `${label} (${parsed.taskId.slice(0, 6)}...)`;
  } catch {
    // Use raw name
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-accent/10 text-accent rounded-full">
      <span className="w-1.5 h-1.5 bg-accent rounded-full" />
      {label}
    </span>
  );
}

// Speech Recognition type declarations
interface SpeechRecognitionEvent {
  results: { [index: number]: { [index: number]: { transcript: string } } };
}

function VoiceButton({
  onResult,
  disabled,
}: {
  onResult: (text: string) => void;
  disabled: boolean;
}) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const isSupported =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const toggleListening = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      onResult(transcript);
      setListening(false);
    };

    recognition.onerror = () => {
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening, onResult]);

  if (!isSupported) return null;

  return (
    <button
      type="button"
      onClick={toggleListening}
      disabled={disabled}
      title={listening ? "Stop listening" : "Voice input"}
      className={`shrink-0 px-2 py-2 text-sm rounded-lg border disabled:opacity-50 transition-colors ${
        listening
          ? "bg-error/10 border-error/30 text-error"
          : "border-border text-on-surface-muted hover:bg-surface-secondary"
      }`}
    >
      {listening ? <MicOff size={16} className="animate-pulse" /> : <Mic size={16} />}
    </button>
  );
}
