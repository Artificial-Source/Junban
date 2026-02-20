import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Search, X, FileText, Hash, Calendar, Flag } from "lucide-react";
import type { Task } from "../../core/types.js";
import type { Project } from "../../core/types.js";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  projects: Project[];
  onSelectTask: (id: string) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "text-red-500",
  2: "text-orange-400",
  3: "text-blue-400",
  4: "text-on-surface-muted",
};

export function SearchModal({ isOpen, onClose, tasks, projects, onSelectTask }: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      // Small delay to ensure the modal is rendered before focusing
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return tasks
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.name.toLowerCase().includes(q)),
      )
      .slice(0, 20);
  }, [tasks, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (task: Task) => {
      onSelectTask(task.id);
      onClose();
    },
    [onSelectTask, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) handleSelect(results[selectedIndex]);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, selectedIndex, handleSelect, onClose],
  );

  if (!isOpen) return null;

  const formatDate = (date: string) => {
    const d = new Date(date);
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);

    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-8 md:pt-[15vh] bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Search tasks"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md mx-3 md:mx-0 bg-surface rounded-xl shadow-2xl overflow-hidden border border-border animate-drop-fade-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search size={16} className="text-on-surface-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks..."
            className="w-full py-3 bg-transparent text-sm text-on-surface placeholder-on-surface-muted focus:outline-none"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="search-results-list"
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="text-on-surface-muted hover:text-on-surface p-0.5 flex-shrink-0"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="search-results-list"
          role="listbox"
          className="max-h-72 overflow-y-auto"
        >
          {query.trim() && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-on-surface-muted">
              No tasks found
            </div>
          )}
          {results.map((task, index) => {
            const project = task.projectId ? projectMap.get(task.projectId) : null;
            const isSelected = index === selectedIndex;

            return (
              <button
                key={task.id}
                data-index={index}
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(task)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${
                  isSelected ? "bg-accent/10" : "hover:bg-surface-secondary"
                }`}
              >
                <FileText
                  size={16}
                  className={`flex-shrink-0 mt-0.5 ${
                    task.status === "completed" ? "text-green-500" : "text-on-surface-muted"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-sm truncate ${
                      task.status === "completed"
                        ? "line-through text-on-surface-muted"
                        : "text-on-surface"
                    }`}
                  >
                    {task.title}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {project && (
                      <span className="flex items-center gap-1 text-xs text-on-surface-muted">
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: project.color }}
                        />
                        {project.name}
                      </span>
                    )}
                    {task.priority && task.priority <= 4 && (
                      <span
                        className={`flex items-center gap-0.5 text-xs ${PRIORITY_COLORS[task.priority] ?? ""}`}
                      >
                        <Flag size={10} />P{task.priority}
                      </span>
                    )}
                    {task.dueDate && (
                      <span className="flex items-center gap-0.5 text-xs text-on-surface-muted">
                        <Calendar size={10} />
                        {formatDate(task.dueDate)}
                      </span>
                    )}
                    {task.tags.length > 0 && (
                      <span className="flex items-center gap-0.5 text-xs text-on-surface-muted">
                        <Hash size={10} />
                        {task.tags.map((t) => t.name).join(", ")}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        {query.trim() && results.length > 0 && (
          <div className="px-4 py-2 border-t border-border flex items-center gap-3 text-xs text-on-surface-muted">
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-tertiary font-mono">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-tertiary font-mono">↵</kbd> open
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-tertiary font-mono">esc</kbd> close
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
