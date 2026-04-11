import { useState, useCallback, memo } from "react";
import { Plus, Trash2, MessageSquare, Check, X, Pencil } from "lucide-react";
import type { ChatSessionInfo } from "../../api/ai.js";

interface ChatHistoryProps {
  sessions: ChatSessionInfo[];
  activeSessionId: string | null;
  onNewChat: () => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  mode: "panel" | "view";
}

export const ChatHistory = memo(function ChatHistory({
  sessions,
  activeSessionId,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
  mode,
}: ChatHistoryProps) {
  const isView = mode === "view";

  if (sessions.length === 0) return null;

  return (
    <div className={`flex flex-col ${isView ? "border-r border-border w-56 shrink-0" : ""}`}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-on-surface-secondary">History</span>
        <button
          onClick={onNewChat}
          title="New chat"
          className="p-1 rounded-md text-on-surface-muted hover:text-accent hover:bg-surface-tertiary transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className={`overflow-auto ${isView ? "flex-1" : "max-h-48"} p-1.5 space-y-0.5`}>
        {sessions.map((session) => (
          <SessionEntry
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === activeSessionId}
            onSwitch={onSwitchSession}
            onDelete={onDeleteSession}
            onRename={onRenameSession}
          />
        ))}
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
  session: ChatSessionInfo;
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
      onRename(session.sessionId, trimmed);
    }
    setEditing(false);
  }, [editTitle, session.sessionId, session.title, onRename]);

  const relativeTime = getRelativeTime(session.createdAt);

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
          className="flex-1 min-w-0 text-xs bg-transparent text-on-surface focus:outline-none"
          autoFocus
        />
        <button onClick={handleConfirmRename} className="p-0.5 text-success hover:text-success/80">
          <Check size={10} />
        </button>
        <button
          onClick={() => setEditing(false)}
          className="p-0.5 text-on-surface-muted hover:text-on-surface"
        >
          <X size={10} />
        </button>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSwitch(session.sessionId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSwitch(session.sessionId);
        }
      }}
      className={`w-full text-left px-2 py-1.5 rounded-md text-xs group flex items-start gap-1.5 transition-colors ${
        isActive
          ? "bg-accent/10 text-accent"
          : "text-on-surface-secondary hover:bg-surface-tertiary"
      }`}
    >
      <MessageSquare size={12} className="shrink-0 mt-0.5 opacity-50" />
      <div className="flex-1 min-w-0">
        <p className="truncate">{session.title}</p>
        <p className="text-[10px] opacity-50 mt-0.5">
          {relativeTime} &middot; {session.messageCount} msgs
        </p>
      </div>
      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleStartRename();
          }}
          title="Rename"
          className="p-0.5 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary"
        >
          <Pencil size={10} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(session.sessionId);
          }}
          title="Delete"
          className="p-0.5 rounded text-on-surface-muted hover:text-error hover:bg-error/10"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}

function getRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
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
