import { useRef, useState, useEffect } from "react";
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
import type { Task } from "../../../core/types.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";

interface TaskDetailHeaderProps {
  task: Task;
  allTasks: Task[];
  projectName: string;
  onClose: () => void;
  onDelete: (id: string) => void;
  onSelect?: (id: string) => void;
  onIndent?: (id: string) => void;
  onOutdent?: (id: string) => void;
  onNavigatePrev?: () => void;
  onNavigateNext?: () => void;
  onOpenFullPage?: (id: string) => void;
  hasPrev: boolean;
  hasNext: boolean;
}

export function TaskDetailHeader({
  task,
  allTasks,
  projectName,
  onClose,
  onDelete,
  onSelect,
  onIndent,
  onOutdent,
  onNavigatePrev,
  onNavigateNext,
  onOpenFullPage,
  hasPrev,
  hasNext,
}: TaskDetailHeaderProps) {
  const { settings } = useGeneralSettings();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // Reset menu when task changes
  useEffect(() => {
    setMoreMenuOpen(false);
  }, [task.id]);

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
    <>
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
    </>
  );
}
