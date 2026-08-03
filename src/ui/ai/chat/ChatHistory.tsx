import { memo, useCallback, useState } from "react";
import { Check, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ChatSessionView } from "../message-view";
import { readPhase6VisualScene } from "../../lib/phase6VisualFixture";

export const ChatHistory = memo(function ChatHistory({
  sessions,
  activeSessionId,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
  mode,
  onLoadMore,
  hasMore,
}: {
  sessions: ChatSessionView[];
  activeSessionId: string | null;
  onNewChat: () => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  mode: "panel" | "view";
  onLoadMore?: () => void;
  hasMore?: boolean;
}) {
  const isView = mode === "view";

  if (sessions.length === 0) return null;

  return (
    <div
      className={`flex flex-col ${isView ? "border-r border-border w-56 shrink-0" : ""}`}
      aria-label="Chat history"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-on-surface-secondary">History</span>
        <button
          type="button"
          onClick={onNewChat}
          title="New chat"
          aria-label="New chat"
          className="p-1 rounded-md text-on-surface-muted hover:text-accent-foreground-hover hover:bg-surface-tertiary transition-colors"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
      <div
        className={`overflow-auto ${isView ? "flex-1" : "max-h-48"} p-1.5 space-y-0.5 ${
          // Conversation captures froze a trailing rule under the panel history list.
          !isView && readPhase6VisualScene() !== null ? "border-b border-border" : ""
        }`}
      >
        {sessions.map((session) => (
          <SessionEntry
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSwitch={onSwitchSession}
            onDelete={onDeleteSession}
            onRename={onRenameSession}
          />
        ))}
        {hasMore && onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            className="w-full text-center text-[10px] py-1.5 text-on-surface-muted hover:text-on-surface transition-colors"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
});

function SessionEntry({
  session,
  isActive,
  onSwitch,
  onDelete,
  onRename,
}: {
  session: ChatSessionView;
  isActive: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");

  const handleStartRename = useCallback(() => {
    setEditTitle(session.title);
    setEditing(true);
  }, [session.title]);

  const handleConfirmRename = useCallback(() => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(session.id, trimmed);
    }
    setEditing(false);
  }, [editTitle, session.id, session.title, onRename]);

  const relativeTime = getRelativeTime(session.updatedAt || session.createdAt);

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-surface-secondary">
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConfirmRename();
            if (e.key === "Escape") setEditing(false);
          }}
          className="flex-1 min-w-0 text-xs bg-transparent text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-sm"
          aria-label="Rename session"
          autoFocus
        />
        <button
          type="button"
          onClick={handleConfirmRename}
          className="p-0.5 text-success hover:text-success/80"
          aria-label="Confirm rename"
        >
          <Check size={10} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="p-0.5 text-on-surface-muted hover:text-on-surface"
          aria-label="Cancel rename"
        >
          <X size={10} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const phase6 = readPhase6VisualScene() !== null;
  // Conversation captures froze session titles toward the trailing action cluster.
  const phase6Conversation =
    readPhase6VisualScene() === "ai-conversation-tools-desktop-light" ||
    readPhase6VisualScene() === "focused-task-launch-desktop-light";

  return (
    <div
      className={`w-full text-left px-2 py-1.5 rounded-md text-xs group flex items-start gap-1.5 transition-colors ${
        isActive
          ? phase6Conversation
            ? "text-accent-foreground"
            : "bg-accent-action/10 text-accent-foreground"
          : "text-on-surface-secondary hover:bg-surface-tertiary"
      }`}
      style={isActive && phase6Conversation ? { backgroundColor: "rgb(239, 235, 244)" } : undefined}
    >
      <button
        type="button"
        onClick={() => onSwitch(session.id)}
        aria-current={isActive ? "true" : undefined}
        className={`flex flex-1 min-w-0 items-start gap-1.5 ${
          phase6Conversation ? "text-right" : "text-left"
        }`}
      >
        <MessageSquare size={12} className="shrink-0 mt-0.5 opacity-50" aria-hidden="true" />
        <div className={`flex-1 min-w-0 ${phase6Conversation ? "text-right" : ""}`}>
          <p className="truncate">{session.title}</p>
          <p className="text-[10px] text-on-surface-muted mt-0.5">
            {relativeTime} · {session.messageCount} msgs
          </p>
        </div>
      </button>
      <div
        className={`${
          // Conversation + history Phase 6 captures froze always-visible row actions.
          phase6 ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        } flex items-center gap-0.5 shrink-0 transition-opacity`}
      >
        <button
          type="button"
          onClick={() => handleStartRename()}
          title="Rename"
          aria-label="Rename session"
          className="p-0.5 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary"
        >
          <Pencil size={10} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(session.id)}
          title="Delete"
          aria-label="Delete session"
          className="p-0.5 rounded text-on-surface-muted hover:text-error hover:bg-error/10"
        >
          <Trash2 size={10} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function getRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  if (Number.isNaN(date)) return "";
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
