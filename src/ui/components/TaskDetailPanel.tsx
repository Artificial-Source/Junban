import { useEffect, useState, useCallback } from "react";
import type { Task, UpdateTaskInput, TaskComment, TaskActivity } from "../../core/types.js";
import * as taskApi from "../api/tasks.js";
import { SubtaskSection } from "./SubtaskSection.js";
import { TaskMetadataSidebar } from "./TaskMetadataSidebar.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { TaskRelations } from "./task-detail/TaskRelations.js";
import { TaskCommentsActivity } from "./task-detail/TaskCommentsActivity.js";
import { TaskDetailHeader } from "./task-detail/TaskDetailHeader.js";
import { TaskDetailDescription } from "./task-detail/TaskDetailDescription.js";

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

function reuseIfSameTaskIds(prev: Task[], next: Task[]): Task[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i]?.id !== next[i]?.id) return next;
  }
  return prev;
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

  // Comments & activity tab state
  const [activeTab, setActiveTab] = useState<"comments" | "activity">("comments");
  const [newComment, setNewComment] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentContent, setEditingCommentContent] = useState("");

  // Subtask inline edit state
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState("");
  const [focusedSubtaskIdx, setFocusedSubtaskIdx] = useState(-1);

  // Relations state
  const [relBlocks, setRelBlocks] = useState<Task[]>([]);
  const [relBlockedBy, setRelBlockedBy] = useState<Task[]>([]);
  const [relSearch, setRelSearch] = useState("");
  const [relSearchOpen, setRelSearchOpen] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setEditingSubtaskId(null);
    setEditingSubtaskTitle("");
    setFocusedSubtaskIdx(-1);
    setNewComment("");
    setEditingCommentId(null);
    setEditingCommentContent("");
    setRelSearch("");
    setRelSearchOpen(false);
  }, [task]);

  // Load relations
  useEffect(() => {
    let cancelled = false;
    taskApi.getTaskRelations(task.id).then((r) => {
      if (!cancelled) {
        setRelBlocks((prev) => reuseIfSameTaskIds(prev, r.blocks));
        setRelBlockedBy((prev) => reuseIfSameTaskIds(prev, r.blockedBy));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

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

  const handleDescriptionChange = useCallback(
    (description: string | null) => {
      onUpdate(task.id, { description });
    },
    [task.id, onUpdate],
  );

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
        className="bg-surface shadow-xl border border-border flex flex-col fixed bottom-0 left-0 right-0 h-[85vh] max-h-[calc(100vh-var(--height-bottom-nav))] rounded-t-xl md:relative md:inset-auto md:rounded-lg md:w-full md:max-w-4xl md:h-[85vh] md:max-h-[85vh] md:mx-4 animate-slide-up-fade md:animate-scale-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <TaskDetailHeader
          task={task}
          allTasks={allTasks}
          projectName={projectName}
          onClose={onClose}
          onDelete={onDelete}
          onSelect={onSelect}
          onIndent={onIndent}
          onOutdent={onOutdent}
          onNavigatePrev={onNavigatePrev}
          onNavigateNext={onNavigateNext}
          onOpenFullPage={onOpenFullPage}
          hasPrev={hasPrev}
          hasNext={hasNext}
        />

        {/* Two-column body */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Left column -- main content */}
          <div className="flex-1 overflow-auto p-3 md:p-6 space-y-4">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              className="w-full text-xl font-semibold bg-transparent border-none focus:outline-none focus:ring-0 text-on-surface"
            />

            {/* Description */}
            <TaskDetailDescription
              description={task.description}
              onDescriptionChange={handleDescriptionChange}
              taskId={task.id}
            />

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

            {/* Relations */}
            <TaskRelations
              task={task}
              allTasks={allTasks}
              relBlocks={relBlocks}
              setRelBlocks={setRelBlocks}
              relBlockedBy={relBlockedBy}
              setRelBlockedBy={setRelBlockedBy}
              relSearch={relSearch}
              setRelSearch={setRelSearch}
              relSearchOpen={relSearchOpen}
              setRelSearchOpen={setRelSearchOpen}
              onSelect={onSelect}
            />

            {/* Comments & Activity */}
            {showCommentsActivity && (
              <TaskCommentsActivity
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                comments={comments}
                activity={activity}
                newComment={newComment}
                setNewComment={setNewComment}
                editingCommentId={editingCommentId}
                setEditingCommentId={setEditingCommentId}
                editingCommentContent={editingCommentContent}
                setEditingCommentContent={setEditingCommentContent}
                onSubmitComment={handleSubmitComment}
                onSaveCommentEdit={handleSaveCommentEdit}
                onUpdateComment={onUpdateComment}
                onDeleteComment={onDeleteComment}
                showAddComment={!!onAddComment}
              />
            )}
          </div>

          {/* Right column -- metadata sidebar */}
          <TaskMetadataSidebar
            task={task}
            onUpdate={onUpdate}
            onDelete={onDelete}
            availableTags={availableTags}
          />
        </div>
      </div>
    </div>
  );
}
