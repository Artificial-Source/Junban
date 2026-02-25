import { useEffect, useState, useRef, useCallback } from "react";
import {
  X,
  Trash2,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Maximize2,
  Inbox,
  MessageSquare,
  History,
  PlusCircle,
  CheckCircle2,
  Pencil,
  Send,
} from "lucide-react";
import { MarkdownMessage } from "./chat/MarkdownMessage.js";
import type { Task, UpdateTaskInput, TaskComment, TaskActivity } from "../../core/types.js";
import { SubtaskSection } from "./SubtaskSection.js";
import { TaskMetadataSidebar } from "./TaskMetadataSidebar.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

interface TaskDetailPanelProps {
  task: Task;
  allTasks?: Task[];
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onIndent?: (id: string) => void;
  onOutdent?: (id: string) => void;
  onSelect?: (id: string) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onToggleSubtask?: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onNavigatePrev?: () => void;
  onNavigateNext?: () => void;
  onOpenFullPage?: (id: string) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  projectName?: string;
  availableTags?: string[];
  comments?: TaskComment[];
  activity?: TaskActivity[];
  onAddComment?: (taskId: string, content: string) => void;
  onUpdateComment?: (commentId: string, content: string) => void;
  onDeleteComment?: (commentId: string) => void;
}

export function TaskDetailPanel({
  task,
  allTasks = [],
  onUpdate,
  onDelete,
  onClose,
  onIndent,
  onOutdent,
  onSelect,
  onAddSubtask,
  onToggleSubtask,
  onReorder,
  onNavigatePrev,
  onNavigateNext,
  onOpenFullPage,
  hasPrev = false,
  hasNext = false,
  projectName = "Inbox",
  availableTags = [],
  comments,
  activity,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
}: TaskDetailPanelProps) {
  const { settings } = useGeneralSettings();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [editingDescription, setEditingDescription] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // Comments & activity tab state
  const [activeTab, setActiveTab] = useState<"comments" | "activity">("comments");
  const [newComment, setNewComment] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentContent, setEditingCommentContent] = useState("");

  // Subtask inline edit state (shared between SubtaskSection and this component)
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState("");
  const [focusedSubtaskIdx, setFocusedSubtaskIdx] = useState(-1);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setEditingDescription(false);
    setMoreMenuOpen(false);
    setEditingSubtaskId(null);
    setEditingSubtaskTitle("");
    setFocusedSubtaskIdx(-1);
    setNewComment("");
    setEditingCommentId(null);
    setEditingCommentContent("");
  }, [task]);

  // Close more menu on outside click
  useEffect(() => {
    if (!moreMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreMenuOpen]);

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleTitleBlur = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed });
    }
  };

  const handleDescriptionBlur = () => {
    const newDesc = description || null;
    if (newDesc !== task.description) {
      onUpdate(task.id, { description: newDesc });
    }
  };

  // Subtask inline edit handlers
  const handleStartEdit = useCallback((child: Task) => {
    setEditingSubtaskId(child.id);
    setEditingSubtaskTitle(child.title);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (editingSubtaskId) {
      const trimmed = editingSubtaskTitle.trim();
      const original = allTasks.find((t) => t.id === editingSubtaskId);
      if (trimmed && original && trimmed !== original.title) {
        onUpdate(editingSubtaskId, { title: trimmed });
      }
      setEditingSubtaskId(null);
      setEditingSubtaskTitle("");
    }
  }, [editingSubtaskId, editingSubtaskTitle, allTasks, onUpdate]);

  const handleCancelEdit = useCallback(() => {
    setEditingSubtaskId(null);
    setEditingSubtaskTitle("");
  }, []);

  // Comment handlers
  const handleSubmitComment = useCallback(() => {
    const trimmed = newComment.trim();
    if (trimmed && onAddComment) {
      onAddComment(task.id, trimmed);
      setNewComment("");
    }
  }, [newComment, onAddComment, task.id]);

  const handleSaveCommentEdit = useCallback(
    (commentId: string) => {
      const trimmed = editingCommentContent.trim();
      if (trimmed && onUpdateComment) {
        onUpdateComment(commentId, trimmed);
      }
      setEditingCommentId(null);
      setEditingCommentContent("");
    },
    [editingCommentContent, onUpdateComment],
  );

  // Format created date for the more menu
  const createdDateLabel = new Date(task.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const createdTimeLabel = new Date(task.createdAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const showCommentsActivity =
    settings.feature_comments !== "false" && (comments !== undefined || activity !== undefined);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      onClick={onClose}
    >
      <div
        className="bg-surface shadow-xl border border-border flex flex-col fixed bottom-0 left-0 right-0 h-[90vh] rounded-t-xl md:relative md:inset-auto md:rounded-lg md:w-full md:max-w-4xl md:h-[85vh] md:mx-4 animate-slide-up-fade md:animate-scale-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — Todoist style */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border flex-shrink-0">
          {/* Left: Project / parent breadcrumb */}
          {task.parentId ? (
            <button
              className="text-xs text-on-surface-muted hover:text-accent flex items-center gap-1.5 transition-colors"
              onClick={() => onSelect?.(task.parentId!)}
            >
              <ArrowLeft size={12} />
              <span className="truncate max-w-[200px]">
                {allTasks.find((t) => t.id === task.parentId)?.title ?? "Parent task"}
              </span>
            </button>
          ) : (
            <span className="text-xs text-on-surface-muted flex items-center gap-1.5">
              <Inbox size={12} />
              {projectName}
            </span>
          )}

          {/* Right: prev/next, more, close */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={onNavigatePrev}
              disabled={!hasPrev}
              className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Previous task"
            >
              <ChevronUp size={16} />
            </button>
            <button
              onClick={onNavigateNext}
              disabled={!hasNext}
              className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors disabled:opacity-30 disabled:pointer-events-none"
              title="Next task"
            >
              <ChevronDown size={16} />
            </button>

            {/* More menu */}
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setMoreMenuOpen((prev) => !prev)}
                className={`p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors ${
                  moreMenuOpen ? "bg-surface-tertiary text-on-surface" : ""
                }`}
                title="More options"
              >
                <MoreHorizontal size={16} />
              </button>
              {moreMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-surface rounded-lg shadow-xl border border-border z-50 py-1 text-sm animate-drop-fade-in">
                  <div className="px-3 py-2 text-xs text-on-surface-muted">
                    Added on {createdDateLabel} &middot; {createdTimeLabel}
                  </div>
                  <div className="border-t border-border my-1" />
                  {onIndent && (
                    <button
                      onClick={() => {
                        onIndent(task.id);
                        setMoreMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-surface-tertiary transition-colors text-on-surface"
                    >
                      <ArrowRight size={14} className="text-on-surface-muted" />
                      Make sub-task
                    </button>
                  )}
                  {onOutdent && task.parentId && (
                    <button
                      onClick={() => {
                        onOutdent(task.id);
                        setMoreMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-surface-tertiary transition-colors text-on-surface"
                    >
                      <ArrowLeft size={14} className="text-on-surface-muted" />
                      Move up one level
                    </button>
                  )}
                  {(onIndent || (onOutdent && task.parentId)) && (
                    <div className="border-t border-border my-1" />
                  )}
                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      if (settings.confirm_delete === "true") {
                        setConfirmDeleteOpen(true);
                        return;
                      }
                      onDelete(task.id);
                    }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-surface-tertiary transition-colors text-error"
                  >
                    <Trash2 size={14} />
                    Delete task
                  </button>
                </div>
              )}
            </div>

            {onOpenFullPage && (
              <button
                onClick={() => {
                  onOpenFullPage(task.id);
                  onClose();
                }}
                aria-label="Open full page"
                className="text-on-surface-muted hover:text-on-surface transition-colors p-1.5 rounded-md hover:bg-surface-tertiary"
                title="Open as full page"
              >
                <Maximize2 size={16} />
              </button>
            )}

            <button
              onClick={onClose}
              aria-label="Close task details"
              className="text-on-surface-muted hover:text-on-surface transition-colors p-1.5 rounded-md hover:bg-surface-tertiary ml-0.5"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Two-column body */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Left column — main content */}
          <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              className="w-full text-xl font-semibold bg-transparent border-none focus:outline-none focus:ring-0 text-on-surface"
            />

            {/* Description with markdown preview / edit toggle */}
            <div className="relative group/desc">
              {editingDescription ? (
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => {
                    handleDescriptionBlur();
                    setEditingDescription(false);
                  }}
                  autoFocus
                  placeholder="Description (supports **markdown**)"
                  className="w-full p-0 text-sm bg-transparent border-none text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-0 min-h-[80px] resize-none"
                />
              ) : description ? (
                <div
                  className="text-sm text-on-surface cursor-text min-h-[80px] prose-sm"
                  onClick={() => setEditingDescription(true)}
                >
                  <MarkdownMessage content={description} />
                </div>
              ) : (
                <button
                  onClick={() => setEditingDescription(true)}
                  className="w-full text-left text-sm text-on-surface-muted/50 min-h-[80px]"
                >
                  Description
                </button>
              )}
              {!editingDescription && description && (
                <button
                  onClick={() => setEditingDescription(true)}
                  className="absolute top-0 right-0 p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary opacity-0 group-hover/desc:opacity-100 transition-opacity"
                  title="Edit description"
                >
                  <Pencil size={14} />
                </button>
              )}
            </div>

            <SubtaskSection
              task={task}
              allTasks={allTasks}
              editingSubtaskId={editingSubtaskId}
              editingSubtaskTitle={editingSubtaskTitle}
              focusedSubtaskIdx={focusedSubtaskIdx}
              onEditTitleChange={setEditingSubtaskTitle}
              onStartEdit={handleStartEdit}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onToggle={onToggleSubtask}
              onSelect={onSelect}
              onAddSubtask={onAddSubtask}
              onReorder={onReorder}
              onFocusedIdxChange={setFocusedSubtaskIdx}
            />

            {/* Comments & Activity */}
            {showCommentsActivity && (
              <div className="border-t border-border pt-4">
                {/* Tabs */}
                <div className="flex gap-4 mb-3 border-b border-border">
                  <button
                    className={`pb-2 text-sm font-medium flex items-center gap-1.5 transition-colors ${
                      activeTab === "comments"
                        ? "text-on-surface border-b-2 border-accent"
                        : "text-on-surface-muted hover:text-on-surface"
                    }`}
                    onClick={() => setActiveTab("comments")}
                  >
                    <MessageSquare size={14} />
                    Comments
                    {comments && comments.length > 0 && (
                      <span className="text-xs text-on-surface-muted ml-0.5">
                        ({comments.length})
                      </span>
                    )}
                  </button>
                  <button
                    className={`pb-2 text-sm font-medium flex items-center gap-1.5 transition-colors ${
                      activeTab === "activity"
                        ? "text-on-surface border-b-2 border-accent"
                        : "text-on-surface-muted hover:text-on-surface"
                    }`}
                    onClick={() => setActiveTab("activity")}
                  >
                    <History size={14} />
                    Activity
                    {activity && activity.length > 0 && (
                      <span className="text-xs text-on-surface-muted ml-0.5">
                        ({activity.length})
                      </span>
                    )}
                  </button>
                </div>

                {/* Comments tab content */}
                {activeTab === "comments" && (
                  <div className="space-y-3">
                    {/* Comment list */}
                    {comments && comments.length > 0 && (
                      <div className="space-y-2">
                        {[...comments]
                          .sort(
                            (a, b) =>
                              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
                          )
                          .map((comment) => (
                            <div
                              key={comment.id}
                              className="group rounded-lg bg-surface-secondary px-3 py-2"
                            >
                              {editingCommentId === comment.id ? (
                                <textarea
                                  value={editingCommentContent}
                                  onChange={(e) => setEditingCommentContent(e.target.value)}
                                  onBlur={() => handleSaveCommentEdit(comment.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                      e.preventDefault();
                                      handleSaveCommentEdit(comment.id);
                                    }
                                    if (e.key === "Escape") {
                                      setEditingCommentId(null);
                                      setEditingCommentContent("");
                                    }
                                  }}
                                  autoFocus
                                  className="w-full text-sm bg-transparent border border-border rounded-md px-2 py-1 text-on-surface focus:outline-none focus:ring-1 focus:ring-accent resize-none min-h-[60px]"
                                />
                              ) : (
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-sm text-on-surface whitespace-pre-wrap flex-1">
                                    {comment.content}
                                  </p>
                                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                    {onUpdateComment && (
                                      <button
                                        onClick={() => {
                                          setEditingCommentId(comment.id);
                                          setEditingCommentContent(comment.content);
                                        }}
                                        className="p-1 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors"
                                        title="Edit comment"
                                      >
                                        <Pencil size={12} />
                                      </button>
                                    )}
                                    {onDeleteComment && (
                                      <button
                                        onClick={() => onDeleteComment(comment.id)}
                                        className="p-1 rounded text-on-surface-muted hover:text-error hover:bg-surface-tertiary transition-colors"
                                        title="Delete comment"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )}
                              <span className="text-xs text-on-surface-muted mt-1 block">
                                {formatRelativeTime(comment.createdAt)}
                                {comment.updatedAt !== comment.createdAt && " (edited)"}
                              </span>
                            </div>
                          ))}
                      </div>
                    )}

                    {comments && comments.length === 0 && (
                      <p className="text-xs text-on-surface-muted italic">No comments yet.</p>
                    )}

                    {/* Add comment */}
                    {onAddComment && (
                      <div className="flex gap-2 items-end">
                        <textarea
                          value={newComment}
                          onChange={(e) => setNewComment(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleSubmitComment();
                            }
                          }}
                          placeholder="Add a comment..."
                          className="flex-1 text-sm bg-transparent border border-border rounded-md px-3 py-2 text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-1 focus:ring-accent resize-none min-h-[36px] max-h-[120px]"
                          rows={1}
                        />
                        <button
                          onClick={handleSubmitComment}
                          disabled={!newComment.trim()}
                          className="px-3 py-2 text-sm font-medium rounded-md bg-accent text-on-accent hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1.5 flex-shrink-0"
                        >
                          <Send size={12} />
                          Comment
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Activity tab content */}
                {activeTab === "activity" && (
                  <div className="space-y-1">
                    {activity && activity.length > 0 ? (
                      [...activity]
                        .sort(
                          (a, b) =>
                            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
                        )
                        .map((entry) => (
                          <div
                            key={entry.id}
                            className="flex items-start gap-2.5 py-1.5 text-xs text-on-surface-muted"
                          >
                            <span className="mt-0.5 flex-shrink-0">
                              {getActivityIcon(entry.action)}
                            </span>
                            <span className="flex-1">{formatActivityDescription(entry)}</span>
                            <span className="flex-shrink-0 whitespace-nowrap">
                              {formatRelativeTime(entry.createdAt)}
                            </span>
                          </div>
                        ))
                    ) : (
                      <p className="text-xs text-on-surface-muted italic py-1">
                        No activity recorded.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right column — metadata sidebar */}
          <TaskMetadataSidebar
            task={task}
            onUpdate={onUpdate}
            onDelete={onDelete}
            availableTags={availableTags}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete task"
        message="This task will be permanently deleted. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          onDelete(task.id);
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}

/** Format an ISO timestamp into a short relative string. */
function formatRelativeTime(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/** Return an icon element for the given activity action. */
function getActivityIcon(action: string) {
  switch (action) {
    case "created":
      return <PlusCircle size={12} />;
    case "completed":
      return <CheckCircle2 size={12} />;
    case "updated":
      return <Pencil size={12} />;
    default:
      return <History size={12} />;
  }
}

/** Build a human-readable description for an activity entry. */
function formatActivityDescription(entry: TaskActivity): string {
  switch (entry.action) {
    case "created":
      return "Task created";
    case "completed":
      return "Task completed";
    case "updated":
      if (entry.field) {
        if (entry.newValue) {
          return `Changed ${entry.field} to "${entry.newValue}"`;
        }
        return `Updated ${entry.field}`;
      }
      return "Task updated";
    default:
      return entry.action.charAt(0).toUpperCase() + entry.action.slice(1);
  }
}
