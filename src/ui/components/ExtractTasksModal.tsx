import { useState, useCallback, useRef } from "react";
import { FileText, Loader2, Check, AlertCircle } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import type { Project } from "../../core/types.js";

/** A single extracted task for preview and selection. */
interface ExtractedTaskItem {
  title: string;
  priority: number | null;
  dueDate: string | null;
  description: string | null;
  assigneeHint: string | null;
  selected: boolean;
}

interface ExtractTasksModalProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  onCreateTasks: (
    tasks: Array<{
      title: string;
      priority: number | null;
      dueDate: string | null;
      description: string | null;
    }>,
    projectId: string | null,
  ) => Promise<void>;
}

const PRIORITY_LABELS: Record<number, { label: string; className: string }> = {
  1: { label: "P1", className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
  2: {
    label: "P2",
    className: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  },
  3: { label: "P3", className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  4: { label: "P4", className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
};

/** Action verbs that indicate a task. */
const ACTION_VERBS =
  /^(review|send|update|create|schedule|prepare|follow[\s-]?up|contact|call|email|write|fix|implement|deploy|check|set[\s-]?up|complete|finalize|submit|organize|plan|discuss|investigate|research|design|test|build|draft|arrange|confirm|approve|cancel|assign|notify|share|clean|move|order|book|coordinate)/i;

/** Patterns that indicate list items. */
const LIST_PREFIX = /^(?:[-*+]|\d+[.)]\s*|(?:TODO|ACTION|AI|TASK)[:\s]+)/i;

/**
 * Heuristic extraction of tasks from unstructured text.
 * Mirrors the logic in the AI tool for client-side preview.
 */
function extractTasksFromText(text: string): ExtractedTaskItem[] {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tasks: ExtractedTaskItem[] = [];

  for (const line of lines) {
    const cleaned = line.replace(LIST_PREFIX, "").trim();
    if (!cleaned || cleaned.length < 5) continue;

    const wasListItem = LIST_PREFIX.test(line);
    const startsWithVerb = ACTION_VERBS.test(cleaned);

    if (wasListItem || startsWithVerb) {
      const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

      let priority: number | null = null;
      if (/\b(urgent|asap|critical|immediately)\b/i.test(cleaned)) priority = 1;
      else if (/\b(important|high[\s-]?priority|soon)\b/i.test(cleaned)) priority = 2;
      else if (/\b(low[\s-]?priority|whenever|someday|eventually)\b/i.test(cleaned)) priority = 4;

      tasks.push({
        title,
        priority,
        dueDate: null,
        description: null,
        assigneeHint: null,
        selected: true,
      });
    }
  }

  return tasks;
}

export function ExtractTasksModal({
  open,
  onClose,
  projects,
  onCreateTasks,
}: ExtractTasksModalProps) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [extractedTasks, setExtractedTasks] = useState<ExtractedTaskItem[]>([]);
  const [phase, setPhase] = useState<"input" | "loading" | "preview" | "success" | "error">(
    "input",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [createdCount, setCreatedCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useFocusTrap(containerRef, open);

  const handleExtract = useCallback(() => {
    if (!text.trim()) return;

    setPhase("loading");

    // Use a microtask to allow UI to update with loading state
    setTimeout(() => {
      try {
        const tasks = extractTasksFromText(text);
        if (tasks.length === 0) {
          setPhase("error");
          setErrorMessage(
            "No actionable tasks found. Try pasting text with bullet points or action items.",
          );
          return;
        }
        setExtractedTasks(tasks);
        setPhase("preview");
      } catch {
        setPhase("error");
        setErrorMessage("Failed to extract tasks from text.");
      }
    }, 100);
  }, [text]);

  const handleToggleTask = useCallback((index: number) => {
    setExtractedTasks((prev) =>
      prev.map((t, i) => (i === index ? { ...t, selected: !t.selected } : t)),
    );
  }, []);

  const handleEditTitle = useCallback((index: number, newTitle: string) => {
    setExtractedTasks((prev) => prev.map((t, i) => (i === index ? { ...t, title: newTitle } : t)));
  }, []);

  const handleCreateSelected = useCallback(async () => {
    const selected = extractedTasks.filter((t) => t.selected);
    if (selected.length === 0) return;

    setPhase("loading");
    try {
      await onCreateTasks(
        selected.map((t) => ({
          title: t.title,
          priority: t.priority,
          dueDate: t.dueDate,
          description: t.description,
        })),
        projectId,
      );
      setCreatedCount(selected.length);
      setPhase("success");
    } catch {
      setPhase("error");
      setErrorMessage("Failed to create some tasks. Please try again.");
    }
  }, [extractedTasks, projectId, onCreateTasks]);

  const handleClose = useCallback(() => {
    setText("");
    setProjectId(null);
    setExtractedTasks([]);
    setPhase("input");
    setErrorMessage("");
    setCreatedCount(0);
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    },
    [handleClose],
  );

  if (!open) return null;

  const selectedCount = extractedTasks.filter((t) => t.selected).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Extract tasks from text"
      onClick={handleClose}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={containerRef}
        className="w-full max-w-lg mx-4 bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4">
          <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
            <FileText size={20} className="text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-on-surface">Extract Tasks</h2>
            <p className="text-xs text-on-surface-muted">
              Paste meeting notes, emails, or any text with action items
            </p>
          </div>
        </div>

        <div className="px-6 pb-6">
          {/* Input phase */}
          {phase === "input" && (
            <div className="space-y-4">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "Paste your text here...\n\nExample:\n- Review the Q4 report\n- Send follow-up email to Sarah\n- Schedule team standup for next week"
                }
                className="w-full h-48 px-3 py-2 text-sm bg-surface-secondary border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-accent text-on-surface placeholder-on-surface-muted"
                autoFocus
              />

              {/* Project selector */}
              <div className="flex items-center gap-2">
                <label
                  htmlFor="extract-project"
                  className="text-sm text-on-surface-muted whitespace-nowrap"
                >
                  Assign to project:
                </label>
                <select
                  id="extract-project"
                  value={projectId ?? ""}
                  onChange={(e) => setProjectId(e.target.value || null)}
                  className="flex-1 px-2 py-1.5 text-sm bg-surface-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent text-on-surface"
                >
                  <option value="">None (Inbox)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2">
                <button
                  onClick={handleClose}
                  className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExtract}
                  disabled={!text.trim()}
                  className="px-5 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Extract Tasks
                </button>
              </div>
            </div>
          )}

          {/* Loading phase */}
          {phase === "loading" && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="text-accent animate-spin" />
              <p className="text-sm text-on-surface-muted mt-3">Extracting tasks...</p>
            </div>
          )}

          {/* Preview phase */}
          {phase === "preview" && (
            <div className="space-y-4">
              <p className="text-sm text-on-surface-muted">
                Found {extractedTasks.length} task{extractedTasks.length !== 1 ? "s" : ""}. Uncheck
                any you don't want to create.
              </p>

              <div className="space-y-2 max-h-64 overflow-auto">
                {extractedTasks.map((task, index) => (
                  <div
                    key={index}
                    className={`flex items-start gap-3 p-2.5 rounded-lg transition-colors ${
                      task.selected ? "bg-surface-secondary" : "bg-surface-secondary/50 opacity-60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={task.selected}
                      onChange={() => handleToggleTask(index)}
                      className="mt-0.5 rounded border-border text-accent focus:ring-accent"
                      aria-label={`Select task: ${task.title}`}
                    />
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        value={task.title}
                        onChange={(e) => handleEditTitle(index, e.target.value)}
                        className="w-full text-sm text-on-surface bg-transparent border-none focus:outline-none focus:ring-0 p-0"
                        aria-label={`Edit task title`}
                      />
                      <div className="flex items-center gap-2 mt-1">
                        {task.priority && PRIORITY_LABELS[task.priority] && (
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded font-medium ${PRIORITY_LABELS[task.priority].className}`}
                          >
                            {PRIORITY_LABELS[task.priority].label}
                          </span>
                        )}
                        {task.dueDate && (
                          <span className="text-xs text-on-surface-muted">{task.dueDate}</span>
                        )}
                        {task.assigneeHint && (
                          <span className="text-xs text-on-surface-muted">
                            @{task.assigneeHint}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div className="flex justify-between items-center">
                <button
                  onClick={() => {
                    setExtractedTasks([]);
                    setPhase("input");
                  }}
                  className="px-4 py-2 text-sm text-on-surface-muted hover:text-on-surface transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleCreateSelected}
                  disabled={selectedCount === 0}
                  className="px-5 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Create {selectedCount} Task{selectedCount !== 1 ? "s" : ""}
                </button>
              </div>
            </div>
          )}

          {/* Success phase */}
          {phase === "success" && (
            <div className="flex flex-col items-center justify-center py-8">
              <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-3">
                <Check size={24} className="text-green-600 dark:text-green-400" />
              </div>
              <p className="text-lg font-semibold text-on-surface">
                {createdCount} task{createdCount !== 1 ? "s" : ""} created
              </p>
              <p className="text-sm text-on-surface-muted mt-1">
                {projectId ? "Tasks added to project" : "Tasks added to Inbox"}
              </p>
              <button
                onClick={handleClose}
                className="mt-4 px-5 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {/* Error phase */}
          {phase === "error" && (
            <div className="flex flex-col items-center justify-center py-8">
              <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-3">
                <AlertCircle size={24} className="text-red-600 dark:text-red-400" />
              </div>
              <p className="text-sm text-on-surface-muted text-center">{errorMessage}</p>
              <button
                onClick={() => {
                  setPhase("input");
                  setErrorMessage("");
                }}
                className="mt-4 px-5 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
