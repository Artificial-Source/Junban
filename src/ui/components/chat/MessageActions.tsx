import { useState, useCallback, memo } from "react";
import { Copy, Check, Pencil, RotateCcw, X, Send } from "lucide-react";
import type { AIChatMessage } from "../../api/index.js";

interface MessageActionsProps {
  message: AIChatMessage;
  isUser: boolean;
  isLastAssistant?: boolean;
  messageIndex?: number;
  onEditAndResend?: (index: number, newText: string) => void;
  onRegenerate?: () => void;
}

export const MessageActions = memo(function MessageActions({
  message,
  isUser,
  isLastAssistant,
  messageIndex,
  onEditAndResend,
  onRegenerate,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  const handleCopy = useCallback(() => {
    if (!message.content) return;
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [message.content]);

  const handleStartEdit = useCallback(() => {
    setEditText(message.content);
    setEditing(true);
  }, [message.content]);

  const handleSubmitEdit = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed && messageIndex !== undefined && onEditAndResend) {
      onEditAndResend(messageIndex, trimmed);
    }
    setEditing(false);
  }, [editText, messageIndex, onEditAndResend]);

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
            className="flex-1 px-2 py-1 text-sm border border-border rounded-md bg-surface text-on-surface focus:outline-none focus:ring-1 focus:ring-accent"
            autoFocus
          />
          <button
            onClick={handleSubmitEdit}
            className="p-1 rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
            title="Send"
          >
            <Send size={12} />
          </button>
          <button
            onClick={() => setEditing(false)}
            className="p-1 rounded-md text-on-surface-muted hover:bg-surface-tertiary transition-colors"
            title="Cancel"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    );
  }

  if (!message.content) return null;

  return (
    <div
      className={`absolute ${
        isUser ? "left-0 -top-7" : "right-0 -top-7"
      } opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 bg-surface border border-border rounded-md shadow-sm p-0.5 z-10`}
    >
      <ActionButton icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={handleCopy} title="Copy" />
      {isUser && onEditAndResend && messageIndex !== undefined && (
        <ActionButton icon={<Pencil size={12} />} onClick={handleStartEdit} title="Edit & resend" />
      )}
      {!isUser && isLastAssistant && onRegenerate && (
        <ActionButton icon={<RotateCcw size={12} />} onClick={onRegenerate} title="Regenerate" />
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
      onClick={onClick}
      title={title}
      className="p-1 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors"
    >
      {icon}
    </button>
  );
}
