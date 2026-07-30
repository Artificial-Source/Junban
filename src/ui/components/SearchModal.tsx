/**
 * Search modal with combobox/listbox semantics and keyboard navigation.
 * Uses the server search endpoint via listTasks with search param.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Search, X } from "lucide-react";
import type { TaskDto, ProjectDto } from "../api/client";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useWorkspace } from "../context/WorkspaceContext";
import { listTasks } from "../api/client";
import { calendarDayKey, formatDate } from "../lib/dates";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTask: (id: string) => void;
}

export function SearchModal({ isOpen, onClose, onSelectTask }: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaskDto[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { catalog } = useWorkspace();
  useFocusTrap(dialogRef, isOpen);

  const projectMap = useMemo(() => {
    const map = new Map<string, ProjectDto>();
    for (const p of catalog?.projects ?? []) map.set(p.id, p);
    return map;
  }, [catalog]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    if (!isOpen || !query.trim()) {
      setResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const response = await listTasks({ search: query.trim(), limit: 20 });
        setResults(response.tasks);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (task: TaskDto) => {
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

  const today = calendarDayKey(new Date().toISOString())!;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-8 md:pt-[15vh] bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Search tasks"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md mx-3 md:mx-0 bg-surface rounded-xl shadow-2xl overflow-hidden border border-border animate-drop-fade-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search size={16} className="text-on-surface-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            className="w-full py-3 bg-transparent text-sm text-on-surface placeholder-on-surface-muted focus:outline-none rounded-sm"
            role="combobox"
            aria-label="Search tasks"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls="search-results-list"
            aria-activedescendant={
              results[selectedIndex] ? `search-result-${selectedIndex}` : undefined
            }
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="text-on-surface-muted hover:text-on-surface"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div
          ref={listRef}
          id="search-results-list"
          role="listbox"
          aria-label="Search results"
          className="max-h-80 overflow-auto"
        >
          {loading && (
            <p className="px-4 py-3 text-sm text-on-surface-muted" role="status">
              Searching…
            </p>
          )}
          {!loading && query.trim() && results.length === 0 && (
            <p className="px-4 py-3 text-sm text-on-surface-muted">No results found.</p>
          )}
          {!loading &&
            results.map((task, index) => {
              const project = task.project_id ? projectMap.get(task.project_id) : null;
              const dueDay = task.due_date ? calendarDayKey(task.due_date) : null;
              const isOverdue = dueDay !== null && task.status === "pending" && dueDay < today;
              return (
                <div
                  key={task.id}
                  data-index={index}
                  id={`search-result-${index}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onClick={() => handleSelect(task)}
                  className={`flex items-center gap-2 px-4 py-2.5 cursor-pointer transition-colors ${
                    index === selectedIndex ? "bg-accent-action/10" : "hover:bg-surface-secondary"
                  }`}
                >
                  <span
                    className={`flex-1 text-sm truncate ${
                      task.status !== "pending"
                        ? "line-through text-on-surface-muted"
                        : "text-on-surface"
                    }`}
                  >
                    {task.title}
                  </span>
                  {project && (
                    <span className="flex items-center gap-1 text-xs text-on-surface-muted flex-shrink-0">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: project.color }}
                      />
                      {project.name}
                    </span>
                  )}
                  {task.due_date && (
                    <span
                      className={`text-xs flex-shrink-0 ${
                        isOverdue ? "text-error font-medium" : "text-on-surface-muted"
                      }`}
                    >
                      {formatDate(task.due_date)}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
