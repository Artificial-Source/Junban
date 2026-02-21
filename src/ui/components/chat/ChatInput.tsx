import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { Send, Phone } from "lucide-react";
import { VoiceButton } from "./VoiceButton.js";
import type { useVoiceContext } from "../../context/VoiceContext.js";

interface ChatInputProps {
  onSubmit: (text: string) => void;
  isStreaming: boolean;
  mode: "panel" | "view";
  voice: ReturnType<typeof useVoiceContext>;
  ttsAvailable: boolean;
  onVoiceResult: (text: string) => void;
  onStartCall?: () => void;
  showCallButton: boolean;
}

export interface ChatInputRef {
  focus: () => void;
}

export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(function ChatInput(
  {
    onSubmit,
    isStreaming,
    mode,
    voice,
    ttsAvailable: _ttsAvailable,
    onVoiceResult,
    onStartCall,
    showCallButton,
  },
  ref,
) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isView = mode === "view";

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  useEffect(() => {
    if (!isStreaming) {
      inputRef.current?.focus();
    }
  }, [isStreaming]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    onSubmit(text);
  };

  if (isView) {
    return (
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto w-full px-4 pb-6">
        <div className="flex items-center gap-2 rounded-2xl bg-surface-secondary border border-border shadow-sm px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything..."
            className="min-w-0 flex-1 bg-transparent text-base text-on-surface placeholder-on-surface-muted focus:outline-none"
          />
          <VoiceButton onResult={onVoiceResult} disabled={isStreaming} voice={voice} />
          {showCallButton && (
            <button
              type="button"
              onClick={onStartCall}
              disabled={isStreaming}
              title="Start voice call"
              className="shrink-0 p-2 text-sm rounded-lg text-on-surface-muted hover:bg-surface-tertiary disabled:opacity-50 transition-colors"
            >
              <Phone size={18} />
            </button>
          )}
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="shrink-0 p-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={18} />
          </button>
        </div>
      </form>
    );
  }

  return (
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
        <VoiceButton onResult={onVoiceResult} disabled={isStreaming} voice={voice} />
        {showCallButton && (
          <button
            type="button"
            onClick={onStartCall}
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
  );
});
