import { MessageSquare, History, Pencil, Trash2, Send } from "lucide-react";
import type { TaskComment, TaskActivity } from "../../../core/types.js";
import {
  formatRelativeTime,
  getActivityIcon,
  formatActivityDescription,
} from "./task-detail-utils.js";

interface TaskCommentsActivityProps {
  activeTab: "comments" | "activity";
  setActiveTab: (tab: "comments" | "activity") => void;
  comments: TaskComment[] | undefined;
  activity: TaskActivity[] | undefined;
  newComment: string;
  setNewComment: (value: string) => void;
  editingCommentId: string | null;
  setEditingCommentId: (id: string | null) => void;
  editingCommentContent: string;
  setEditingCommentContent: (value: string) => void;
  onSubmitComment: () => void;
  onSaveCommentEdit: (commentId: string) => void;
  onUpdateComment?: (commentId: string, content: string) => void;
  onDeleteComment?: (commentId: string) => void;
  showAddComment: boolean;
}

export function TaskCommentsActivity({
  activeTab,
  setActiveTab,
  comments,
  activity,
  newComment,
  setNewComment,
  editingCommentId,
  setEditingCommentId,
  editingCommentContent,
  setEditingCommentContent,
  onSubmitComment,
  onSaveCommentEdit,
  onUpdateComment,
  onDeleteComment,
  showAddComment,
}: TaskCommentsActivityProps) {
  return (
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
            <span className="text-xs text-on-surface-muted ml-0.5">({comments.length})</span>
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
            <span className="text-xs text-on-surface-muted ml-0.5">({activity.length})</span>
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
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                .map((comment) => (
                  <div key={comment.id} className="group rounded-lg bg-surface-secondary px-3 py-2">
                    {editingCommentId === comment.id ? (
                      <textarea
                        value={editingCommentContent}
                        onChange={(e) => setEditingCommentContent(e.target.value)}
                        onBlur={() => onSaveCommentEdit(comment.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            onSaveCommentEdit(comment.id);
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
          {showAddComment && (
            <div className="flex gap-2 items-end">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSubmitComment();
                  }
                }}
                placeholder="Add a comment..."
                className="flex-1 text-sm bg-transparent border border-border rounded-md px-3 py-2 text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-1 focus:ring-accent resize-none min-h-[36px] max-h-[120px]"
                rows={1}
              />
              <button
                onClick={onSubmitComment}
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
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2.5 py-1.5 text-xs text-on-surface-muted"
                >
                  <span className="mt-0.5 flex-shrink-0">{getActivityIcon(entry.action)}</span>
                  <span className="flex-1">{formatActivityDescription(entry)}</span>
                  <span className="flex-shrink-0 whitespace-nowrap">
                    {formatRelativeTime(entry.createdAt)}
                  </span>
                </div>
              ))
          ) : (
            <p className="text-xs text-on-surface-muted italic py-1">No activity recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}
