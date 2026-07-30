/**
 * Add/Edit Project modal.
 * Preserves the legacy dialog pattern for project creation.
 */
import { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useCatalogMutations } from "../hooks/useCatalogMutations";

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
}

const PROJECT_COLORS = [
  "#8a2be2",
  "#dc3545",
  "#e6a817",
  "#28a745",
  "#17a2b8",
  "#fd7e14",
  "#6f42c1",
  "#20c997",
  "#0d6efd",
  "#d63384",
];

export function AddProjectModal({ open, onClose }: AddProjectModalProps) {
  const { createProject } = useCatalogMutations();
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]!);
  const [view, setView] = useState<"list" | "board">("list");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, open);

  // Escape closes while not submitting, matching other dialogs.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || submitting) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createProject({ name: name.trim(), color, view });
      if (result) {
        setName("");
        onClose();
      } else {
        setError("Could not create project.");
      }
    } catch {
      setError("Could not create project.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-project-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md mx-4 bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in overflow-hidden"
        aria-busy={submitting || undefined}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="add-project-title" className="text-sm font-semibold text-on-surface">
            New Project
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="p-1 text-on-surface-muted hover:text-on-surface rounded-md hover:bg-surface-tertiary"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-4 space-y-4">
          <div>
            <label
              htmlFor="project-name"
              className="block text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-1"
            >
              Name
            </label>
            <input
              ref={nameRef}
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit();
              }}
              className="w-full px-3 py-2 border border-border rounded-lg bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-focus"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-1">
              Color
            </label>
            <div className="flex flex-wrap gap-2">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${
                    color === c ? "border-on-surface scale-110" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-1">
              View
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setView("list")}
                aria-pressed={view === "list"}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  view === "list"
                    ? "bg-accent-action text-on-accent-action"
                    : "border border-border text-on-surface-secondary"
                }`}
              >
                List
              </button>
              <button
                onClick={() => setView("board")}
                aria-pressed={view === "board"}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  view === "board"
                    ? "bg-accent-action text-on-accent-action"
                    : "border border-border text-on-surface-secondary"
                }`}
              >
                Board
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          )}
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting || !name.trim()}
            className="w-full rounded-lg bg-accent-action px-4 py-2.5 text-sm font-medium text-on-accent-action hover:bg-accent-action-hover disabled:opacity-50"
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}
