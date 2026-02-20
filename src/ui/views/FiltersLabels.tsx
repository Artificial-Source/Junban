import { useState, useEffect, useMemo, useCallback } from "react";
import { SlidersHorizontal, Tag, ChevronDown, ChevronRight, Plus, X, Filter } from "lucide-react";
import { api } from "../api/index.js";
import type { Task } from "../../core/types.js";

interface SavedFilter {
  id: string;
  name: string;
  query: string;
}

interface FiltersLabelsProps {
  tasks: Task[];
  onNavigateToFilter: (query: string) => void;
}

const SAVED_FILTERS_KEY = "saved_filters";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function FiltersLabels({ tasks, onNavigateToFilter }: FiltersLabelsProps) {
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [labelsExpanded, setLabelsExpanded] = useState(true);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [tags, setTags] = useState<{ id: string; name: string; color: string }[]>([]);
  const [showAddFilter, setShowAddFilter] = useState(false);
  const [newFilterName, setNewFilterName] = useState("");
  const [newFilterQuery, setNewFilterQuery] = useState("");
  const [showAddTag, setShowAddTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");

  // Load saved filters from app settings
  useEffect(() => {
    api.getAppSetting(SAVED_FILTERS_KEY).then((val) => {
      if (val) {
        try {
          setSavedFilters(JSON.parse(val));
        } catch {
          // ignore
        }
      }
    });
  }, []);

  // Load tags
  useEffect(() => {
    api
      .listTags()
      .then(setTags)
      .catch(() => {});
  }, []);

  const persistFilters = useCallback((filters: SavedFilter[]) => {
    setSavedFilters(filters);
    api.setAppSetting(SAVED_FILTERS_KEY, JSON.stringify(filters)).catch(() => {});
  }, []);

  const handleAddFilter = () => {
    if (!newFilterName.trim() || !newFilterQuery.trim()) return;
    const filter: SavedFilter = {
      id: generateId(),
      name: newFilterName.trim(),
      query: newFilterQuery.trim(),
    };
    persistFilters([...savedFilters, filter]);
    setNewFilterName("");
    setNewFilterQuery("");
    setShowAddFilter(false);
  };

  const handleDeleteFilter = (id: string) => {
    persistFilters(savedFilters.filter((f) => f.id !== id));
  };

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    // Creating a tag by creating and immediately filtering - for now just navigate to the tag query
    // Tags are auto-created when assigned to tasks, so we just navigate
    setNewTagName("");
    setShowAddTag(false);
    onNavigateToFilter(`#${newTagName.trim()}`);
  };

  // Compute pending task count per tag
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (task.status !== "pending") continue;
      for (const tag of task.tags) {
        counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
      }
    }
    return counts;
  }, [tasks]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <SlidersHorizontal size={24} className="text-accent" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Filters & Labels</h1>
      </div>

      {/* My Filters Section */}
      <div className="mb-6">
        <button
          onClick={() => setFiltersExpanded(!filtersExpanded)}
          className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-2 hover:text-accent transition-colors"
        >
          {filtersExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          My Filters
        </button>

        {filtersExpanded && (
          <div className="ml-1">
            {savedFilters.length === 0 && !showAddFilter && (
              <p className="text-sm text-on-surface-muted py-2 px-3">
                Your list of filters will show up here.
              </p>
            )}

            <div className="space-y-0.5">
              {savedFilters.map((filter) => (
                <div
                  key={filter.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-secondary transition-colors group cursor-pointer"
                  onClick={() => onNavigateToFilter(filter.query)}
                >
                  <Filter size={16} className="text-on-surface-muted flex-shrink-0" />
                  <span className="flex-1 text-sm text-on-surface">{filter.name}</span>
                  <span className="text-xs text-on-surface-muted">{filter.query}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteFilter(filter.id);
                    }}
                    aria-label={`Delete filter "${filter.name}"`}
                    className="opacity-0 group-hover:opacity-100 text-on-surface-muted hover:text-error transition-opacity"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>

            {showAddFilter ? (
              <div className="mt-2 px-3 space-y-2">
                <input
                  type="text"
                  value={newFilterName}
                  onChange={(e) => setNewFilterName(e.target.value)}
                  placeholder="Filter name"
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
                  autoFocus
                />
                <input
                  type="text"
                  value={newFilterQuery}
                  onChange={(e) => setNewFilterQuery(e.target.value)}
                  placeholder="Query (e.g., p1, #work, overdue)"
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddFilter();
                    if (e.key === "Escape") setShowAddFilter(false);
                  }}
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleAddFilter}
                    className="px-3 py-1 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => setShowAddFilter(false)}
                    className="px-3 py-1 text-xs font-medium rounded-md text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAddFilter(true)}
                className="flex items-center gap-2 mt-1 px-3 py-1.5 text-sm text-on-surface-muted hover:text-accent transition-colors"
              >
                <Plus size={14} />
                Add filter
              </button>
            )}
          </div>
        )}
      </div>

      {/* Labels Section */}
      <div>
        <button
          onClick={() => setLabelsExpanded(!labelsExpanded)}
          className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-2 hover:text-accent transition-colors"
        >
          {labelsExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Labels
        </button>

        {labelsExpanded && (
          <div className="ml-1">
            {tags.length === 0 && !showAddTag && (
              <p className="text-sm text-on-surface-muted py-2 px-3">
                No labels yet. Labels are created when you add tags to tasks.
              </p>
            )}

            <div className="space-y-0.5">
              {tags.map((tag) => {
                const count = tagCounts.get(tag.name) ?? 0;
                return (
                  <div
                    key={tag.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-secondary transition-colors cursor-pointer"
                    onClick={() => onNavigateToFilter(`#${tag.name}`)}
                  >
                    {tag.color ? (
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: tag.color }}
                      />
                    ) : (
                      <Tag size={16} className="text-on-surface-muted flex-shrink-0" />
                    )}
                    <span className="flex-1 text-sm text-on-surface">{tag.name}</span>
                    {count > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface-tertiary text-on-surface-secondary">
                        {count}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {showAddTag ? (
              <div className="mt-2 px-3 flex items-center gap-2">
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="Tag name"
                  className="flex-1 px-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddTag();
                    if (e.key === "Escape") setShowAddTag(false);
                  }}
                />
                <button
                  onClick={handleAddTag}
                  className="px-3 py-1 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
                >
                  Go
                </button>
                <button
                  onClick={() => setShowAddTag(false)}
                  className="px-3 py-1 text-xs font-medium rounded-md text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddTag(true)}
                className="flex items-center gap-2 mt-1 px-3 py-1.5 text-sm text-on-surface-muted hover:text-accent transition-colors"
              >
                <Plus size={14} />
                Add label
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
