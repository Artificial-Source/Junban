import { memo, useCallback, useState } from "react";
import { Check, Copy, Pencil, RotateCcw, Send, X } from "lucide-react";
import type { ChatMessageView } from "../message-view";

export const MessageActions = memo(function MessageActions({
  message,
  isUser,
  isLastAssistant,
  onEditAndResend,
  onRegenerate,
}: {
  message: ChatMessageView;
  isUser: boolean;
  isLastAssistant?: boolean;
  onEditAndResend?: (messageId: string, newText: string) => void;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  const handleCopy = useCallback(() => {
    if (!message.text) return;
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [message.text]);

  const handleStartEdit = useCallback(() => {
    setEditText(message.text);
    setEditing(true);
  }, [message.text]);

  const handleSubmitEdit = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed && onEditAndResend) {
      onEditAndResend(message.id, trimmed);
    }
    setEditing(false);
  }, [editText, message.id, onEditAndResend]);

  if (editing && isUser) {
    return (
      <div className="mb-1">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmitEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="flex-1 px-2 py-1 text-sm border border-border rounded-md bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
            aria-label="Edit message"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSubmitEdit}
            className="p-1 rounded-md bg-accent-action text-on-accent-action hover:bg-accent-action-hover transition-colors"
            title="Send"
            aria-label="Send edited message"
          >
            <Send size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="p-1 rounded-md text-on-surface-muted hover:bg-surface-tertiary transition-colors"
            title="Cancel"
            aria-label="Cancel edit"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (!message.text) return null;

  return (
    <div
      className={`absolute ${
        isUser ? "left-0 -top-7" : "right-0 -top-7"
      } opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5 bg-surface border border-border rounded-md shadow-sm p-0.5 z-10`}
    >
      <ActionButton
        icon={
          copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />
        }
        onClick={handleCopy}
        title="Copy"
      />
      {isUser && onEditAndResend && !message.optimistic && (
        <ActionButton
          icon={<Pencil size={12} aria-hidden="true" />}
          onClick={handleStartEdit}
          title="Edit & resend"
        />
      )}
      {!isUser && isLastAssistant && onRegenerate && (
        <ActionButton
          icon={<RotateCcw size={12} aria-hidden="true" />}
          onClick={onRegenerate}
          title="Regenerate"
        />
      )}
    </div>
  );
});

function ActionButton({
  icon,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="p-1 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors"
    >
      {icon}
    </button>
  );
}
