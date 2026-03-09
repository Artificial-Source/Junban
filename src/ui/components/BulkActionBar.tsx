import { useState } from "react";
import { CheckCircle, Trash2, FolderOpen, Tag, X } from "lucide-react";
import type { Project } from "../../core/types.js";

interface BulkActionBarProps {
  selectedCount: number;
  onCompleteAll: () => void;
  onDeleteAll: () => void;
  onMoveToProject: (projectId: string | null) => void;
  onAddTag: (tag: string) => void;
  onClear: () => void;
  projects: Project[];
}

export function BulkActionBar({
  selectedCount,
  onCompleteAll,
  onDeleteAll,
  onMoveToProject,
  onAddTag,
  onClear,
  projects,
}: BulkActionBarProps) {
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showTagInput, setShowTagInput] = useState(false);

  if (selectedCount === 0) return null;

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 mb-2 bg-accent/10 border border-accent/20 rounded-lg">
      <span className="text-sm font-medium text-accent">{selectedCount} selected</span>
      <div className="flex items-center gap-1 ml-auto">
        <button
          onClick={onCompleteAll}
          className="px-3 py-1 text-xs rounded-md bg-success/10 text-success hover:bg-success/20 flex items-center gap-1.5 transition-colors"
        >
          <CheckCircle size={14} />
          Complete
        </button>
        <button
          onClick={onDeleteAll}
          className="px-3 py-1 text-xs rounded-md bg-error/10 text-error hover:bg-error/20 flex items-center gap-1.5 transition-colors"
        >
          <Trash2 size={14} />
          Delete
        </button>
        <div className="relative">
          <button
            onClick={() => setShowProjectMenu((v) => !v)}
            className="px-3 py-1 text-xs rounded-md bg-surface-tertiary text-on-surface-secondary hover:bg-border flex items-center gap-1.5 transition-colors"
          >
            <FolderOpen size={14} />
            Move
          </button>
          {showProjectMenu && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg z-20">
              <button
                onClick={() => {
                  onMoveToProject(null);
                  setShowProjectMenu(false);
                }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-surface-secondary text-on-surface-muted"
              >
                No Project (Inbox)
              </button>
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onMoveToProject(p.id);
                    setShowProjectMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-on-surface hover:bg-surface-secondary"
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {showTagInput ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (tagInput.trim()) {
                onAddTag(tagInput.trim());
                setTagInput("");
                setShowTagInput(false);
              }
            }}
            className="flex items-center gap-1"
          >
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="Tag name"
              autoFocus
              className="w-24 px-2 py-1 text-xs border border-border rounded bg-surface text-on-surface"
              onBlur={() => {
                if (!tagInput) setShowTagInput(false);
              }}
            />
          </form>
        ) : (
          <button
            onClick={() => setShowTagInput(true)}
            className="px-3 py-1 text-xs rounded-md bg-surface-tertiary text-on-surface-secondary hover:bg-border flex items-center gap-1.5 transition-colors"
          >
            <Tag size={14} />
            Tag
          </button>
        )}
        <button
          onClick={onClear}
          aria-label="Clear selection"
          className="px-2 py-1 text-xs rounded-md text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
