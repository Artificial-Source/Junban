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
} from "lucide-react";
import type { Task, UpdateTaskInput } from "../../core/types.js";
import { SubtaskSection } from "./SubtaskSection.js";
import { TaskMetadataSidebar } from "./TaskMetadataSidebar.js";

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
}: TaskDetailPanelProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // Subtask inline edit state (shared between SubtaskSection and this component)
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState("");
  const [focusedSubtaskIdx, setFocusedSubtaskIdx] = useState(-1);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setMoreMenuOpen(false);
    setEditingSubtaskId(null);
    setEditingSubtaskTitle("");
    setFocusedSubtaskIdx(-1);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-xl border border-border w-full max-w-4xl h-[85vh] flex flex-col mx-4"
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
                <div className="absolute right-0 top-full mt-1 w-56 bg-surface rounded-lg shadow-xl border border-border z-50 py-1 text-sm">
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
        <div className="flex flex-1 overflow-hidden">
          {/* Left column — main content */}
          <div className="flex-1 overflow-auto p-6 space-y-4">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              className="w-full text-xl font-semibold bg-transparent border-none focus:outline-none focus:ring-0 text-on-surface"
            />

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={handleDescriptionBlur}
              placeholder="Description"
              className="w-full p-0 text-sm bg-transparent border-none text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-0 min-h-[80px] resize-none"
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
    </div>
  );
}
