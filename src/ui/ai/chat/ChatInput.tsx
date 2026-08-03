import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Phone, Send, Square } from "lucide-react";
import { isPhase6VisualFixture } from "../../lib/phase6VisualFixture";
import { VoiceButton, type VoiceButtonPresentationState, type VoiceError } from "../../voice";

export interface ChatInputRef {
  focus: () => void;
  setValue: (value: string) => void;
}

export type ChatInputVoiceProps = {
  buttonState: VoiceButtonPresentationState;
  onTogglePtt: () => void;
  permissionError?: string | null;
  error?: VoiceError | null;
  onRetryPermission?: () => void;
  showPttButton: boolean;
  showCallButton: boolean;
  onStartCall?: () => void;
};

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
    /** Optional voice controls (PTT + start call). */
    voice?: ChatInputVoiceProps | null;
  }
>(function ChatInput(
  { onSubmit, onStop, isStreaming, mode, prefill = "", placeholder, voice = null },
  ref,
) {
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
    // Immutable visual fixtures must not show a focused input ring.
    if (isPhase6VisualFixture()) return;
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

  const voiceControls = voice ? (
    <>
      {voice.showPttButton && (
        <VoiceButton
          onToggle={voice.onTogglePtt}
          disabled={isStreaming}
          state={voice.buttonState}
          permissionError={voice.permissionError}
          error={voice.error}
          onRetry={voice.onRetryPermission}
        />
      )}
      {voice.showCallButton && (
        <button
          type="button"
          onClick={voice.onStartCall}
          disabled={isStreaming}
          aria-label="Start voice call"
          title="Start voice call"
          data-testid="start-voice-call"
          className={
            isView
              ? "shrink-0 p-2 text-sm rounded-lg text-on-surface-muted hover:bg-surface-tertiary disabled:opacity-50 transition-colors"
              : "shrink-0 px-2.5 py-2.5 text-sm rounded-lg border border-border text-on-surface-muted hover:bg-surface-secondary disabled:opacity-50 transition-colors"
          }
        >
          <Phone size={isView ? 18 : 16} aria-hidden="true" />
        </button>
      )}
    </>
  ) : null;

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
          {voiceControls}
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
              className={
                isPhase6VisualFixture()
                  ? "shrink-0 p-2 text-sm text-on-surface-muted rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  : "shrink-0 p-2 text-sm bg-accent-action text-on-accent-action rounded-lg hover:bg-accent-action-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              }
            >
              <Send size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
    );
  }

  const phase6 = isPhase6VisualFixture();

  return (
    <form
      onSubmit={handleSubmit}
      className={phase6 ? "px-3 pt-3 pb-0 border-t border-border" : "p-3 border-t border-border"}
    >
      <div className={`flex items-center ${phase6 ? "gap-1.5" : "gap-2"}`}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder ?? defaultPlaceholder}
          aria-label="Message"
          className={
            phase6
              ? "min-w-0 flex-1 px-3 h-[22px] text-[13px] leading-none rounded-full bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none"
              : "min-w-0 flex-1 px-3 py-2.5 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
          }
          style={phase6 ? { border: "1px solid #1d1d1f", boxShadow: "none" } : undefined}
        />
        {voiceControls}
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
            className={
              phase6
                ? "shrink-0 p-1.5 text-sm text-on-surface-muted rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                : "shrink-0 px-3 py-2.5 text-sm bg-accent-action text-on-accent-action rounded-lg hover:bg-accent-action-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            }
          >
            <Send size={phase6 ? 14 : 16} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
});
