import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Send, Square } from "lucide-react";

export interface ChatInputRef {
  focus: () => void;
  setValue: (value: string) => void;
}

export const ChatInput = forwardRef<
  ChatInputRef,
  {
    onSubmit: (text: string) => void;
    onStop?: () => void;
    isStreaming: boolean;
    mode: "panel" | "view";
    prefill?: string;
    /** Placeholder override (focused task, etc.). */
    placeholder?: string;
  }
>(function ChatInput({ onSubmit, onStop, isStreaming, mode, prefill = "", placeholder }, ref) {
  const [input, setInput] = useState(prefill);
  const inputRef = useRef<HTMLInputElement>(null);
  const isView = mode === "view";

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    setValue: (value: string) => setInput(value),
  }));

  useEffect(() => {
    if (prefill) setInput(prefill);
  }, [prefill]);

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

  const defaultPlaceholder = isView ? "Ask anything..." : "Ask about your tasks...";

  if (isView) {
    return (
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto w-full px-4 pb-6">
        <div className="flex items-center gap-2 rounded-2xl bg-surface-secondary border border-border shadow-sm px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder ?? defaultPlaceholder}
            aria-label="Message"
            className="min-w-0 flex-1 bg-transparent text-base text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-sm"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="shrink-0 p-2 text-sm rounded-lg bg-error/10 text-error hover:bg-error/20 transition-colors"
            >
              <Square size={18} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Send message"
              className="shrink-0 p-2 text-sm bg-accent-action text-on-accent-action rounded-lg hover:bg-accent-action-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={18} aria-hidden="true" />
            </button>
          )}
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
          placeholder={placeholder ?? defaultPlaceholder}
          aria-label="Message"
          className="min-w-0 flex-1 px-3 py-2.5 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="shrink-0 px-3 py-2.5 text-sm rounded-lg bg-error/10 text-error hover:bg-error/20 transition-colors"
          >
            <Square size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            aria-label="Send message"
            className="shrink-0 px-3 py-2.5 text-sm bg-accent-action text-on-accent-action rounded-lg hover:bg-accent-action-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
});
