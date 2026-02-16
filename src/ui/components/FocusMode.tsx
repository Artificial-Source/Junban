import { useState, useEffect, useCallback } from "react";
import { X, Check, SkipForward, ChevronLeft } from "lucide-react";
import type { Task } from "../../core/types.js";

interface FocusModeProps {
  tasks: Task[];
  onComplete: (id: string) => void;
  onClose: () => void;
}

export function FocusMode({ tasks, onComplete, onClose }: FocusModeProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  const currentTask = tasks[currentIndex] ?? null;
  const total = tasks.length;
  const progress = total > 0 ? currentIndex + 1 : 0;

  const goNext = useCallback(() => {
    if (currentIndex < total - 1) {
      setCurrentIndex((i) => i + 1);
    }
  }, [currentIndex, total]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
    }
  }, [currentIndex]);

  const completeAndAdvance = useCallback(() => {
    if (!currentTask) return;
    onComplete(currentTask.id);
    // After completing, the task list shrinks. Stay at same index (which now points to the next task).
    // If we're at the end, we'll go to the last available.
    if (currentIndex >= total - 1) {
      setCurrentIndex(Math.max(0, total - 2));
    }
  }, [currentTask, currentIndex, total, onComplete]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          completeAndAdvance();
          break;
        case "n":
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          goNext();
          break;
        case "p":
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          goPrev();
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [completeAndAdvance, goNext, goPrev, onClose]);

  if (total === 0) {
    return (
      <div
        role="dialog"
        aria-label="Focus mode"
        className="fixed inset-0 z-50 bg-surface/95 backdrop-blur-sm flex items-center justify-center"
      >
        <div className="text-center">
          <h2 className="text-2xl font-bold text-on-surface mb-2">All done!</h2>
          <p className="text-on-surface-muted mb-6">No more pending tasks to focus on.</p>
          <button
            onClick={onClose}
            className="px-6 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
          >
            Exit Focus Mode
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Focus mode"
      className="fixed inset-0 z-50 bg-surface/95 backdrop-blur-sm flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-on-surface-muted">Focus Mode</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent font-medium">
            {progress}/{total}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Exit focus mode"
          className="p-2 text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary rounded-lg transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-surface-tertiary">
        <div
          className="h-full bg-accent transition-all duration-300"
          style={{ width: `${(progress / total) * 100}%` }}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-2xl w-full text-center">
          {/* Priority indicator */}
          {currentTask!.priority && (
            <span
              className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mb-4 ${
                currentTask!.priority === 1
                  ? "bg-priority-1/15 text-priority-1"
                  : currentTask!.priority === 2
                    ? "bg-priority-2/15 text-priority-2"
                    : currentTask!.priority === 3
                      ? "bg-priority-3/15 text-priority-3"
                      : "bg-priority-4/15 text-priority-4"
              }`}
            >
              P{currentTask!.priority}
            </span>
          )}

          <h1 className="text-4xl font-bold text-on-surface mb-4 leading-tight">
            {currentTask!.title}
          </h1>

          {currentTask!.description && (
            <p className="text-lg text-on-surface-secondary mb-6 whitespace-pre-wrap">
              {currentTask!.description}
            </p>
          )}

          {/* Tags */}
          {currentTask!.tags.length > 0 && (
            <div className="flex gap-2 justify-center mb-6 flex-wrap">
              {currentTask!.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="font-mono text-sm px-2.5 py-1 rounded-lg bg-surface-tertiary text-on-surface-secondary"
                >
                  #{tag.name}
                </span>
              ))}
            </div>
          )}

          {/* Due date */}
          {currentTask!.dueDate && (
            <p
              className={`text-sm mb-6 ${
                new Date(currentTask!.dueDate) < new Date()
                  ? "text-error font-medium"
                  : "text-on-surface-muted"
              }`}
            >
              Due: {new Date(currentTask!.dueDate).toLocaleDateString()}
            </p>
          )}

          {/* Sub-tasks checklist */}
          {currentTask!.children && currentTask!.children.length > 0 && (
            <div className="text-left max-w-md mx-auto mb-6 space-y-2">
              {currentTask!.children.map((child) => (
                <div
                  key={child.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-secondary"
                >
                  <span
                    className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${
                      child.status === "completed"
                        ? "bg-success border-success"
                        : "border-on-surface-muted"
                    }`}
                  />
                  <span
                    className={`text-sm ${
                      child.status === "completed"
                        ? "line-through text-on-surface-muted"
                        : "text-on-surface"
                    }`}
                  >
                    {child.title}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer controls */}
      <div className="px-6 py-6 flex items-center justify-center gap-4">
        <button
          onClick={goPrev}
          disabled={currentIndex === 0}
          aria-label="Previous task"
          className="flex items-center gap-1 px-4 py-2.5 rounded-lg text-sm font-medium bg-surface-tertiary text-on-surface-secondary hover:text-on-surface transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} /> Previous
        </button>

        <button
          onClick={completeAndAdvance}
          className="flex items-center gap-2 px-8 py-3 rounded-lg text-base font-medium bg-success text-white hover:bg-success/90 transition-colors shadow-sm"
        >
          <Check size={20} /> Complete
        </button>

        <button
          onClick={goNext}
          disabled={currentIndex >= total - 1}
          aria-label="Skip to next task"
          className="flex items-center gap-1 px-4 py-2.5 rounded-lg text-sm font-medium bg-surface-tertiary text-on-surface-secondary hover:text-on-surface transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Skip <SkipForward size={16} />
        </button>
      </div>

      {/* Keyboard hint */}
      <div className="pb-4 text-center">
        <p className="text-xs text-on-surface-muted">
          <kbd className="px-1.5 py-0.5 bg-surface-tertiary rounded text-xs">Space</kbd> Complete
          {" · "}
          <kbd className="px-1.5 py-0.5 bg-surface-tertiary rounded text-xs">N</kbd> Next
          {" · "}
          <kbd className="px-1.5 py-0.5 bg-surface-tertiary rounded text-xs">P</kbd> Previous
          {" · "}
          <kbd className="px-1.5 py-0.5 bg-surface-tertiary rounded text-xs">Esc</kbd> Exit
        </p>
      </div>
    </div>
  );
}
