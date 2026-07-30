/**
 * Filters & Labels view: query bar, tags management, saved filters CRUD.
 * Preserves the legacy layout with query input, tag list, and saved filter list.
 */
import { useState, useMemo } from "react";
import { SlidersHorizontal, Hash, Plus, Trash2, Save } from "lucide-react";
import type { TagDto, SavedFilterDto, ParsedFilterResponse, TaskListParams } from "../api/client";
import { parseFilter } from "../api/client";
import { useWorkspace } from "../context/WorkspaceContext";
import { useCatalogMutations } from "../hooks/useCatalogMutations";
import { useViewTasks } from "../hooks/useViewTasks";
import { TaskList } from "../components/TaskList";
import { TemplatesSection } from "../components/TemplatesSection";
import { useToday } from "../hooks/useToday";
import { taskListParamsFromParsedFilter } from "../lib/filterQueryParams";
import type { AppRoute } from "../hooks/useRouting";

interface FiltersLabelsProps {
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    orderedIds: string[],
  ) => void;
  onNavigate: (target: AppRoute) => void;
  onToggleTask: (id: string) => Promise<boolean>;
}

export function FiltersLabels({
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onNavigate,
  onToggleTask,
}: FiltersLabelsProps) {
  const { catalog } = useWorkspace();
  const { createTag, deleteTag, createSavedFilter } = useCatalogMutations();
  const today = useToday();

  const [query, setQuery] = useState("");
  const [parsedFilter, setParsedFilter] = useState<ParsedFilterResponse | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [filterName, setFilterName] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#8a2be2");

  const tags = useMemo(
    () => (catalog?.tags ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    [catalog],
  );

  const savedFilters = useMemo(
    () => (catalog?.saved_filters ?? []).sort((a, b) => a.sort_order - b.sort_order),
    [catalog],
  );

  const templates = catalog?.templates ?? [];

  const handleParse = async () => {
    if (!query.trim()) {
      setParsedFilter(null);
      setParseError(null);
      return;
    }
    try {
      const result = await parseFilter({ input: query.trim() });
      if (!catalog) {
        setParsedFilter(null);
        setParseError("Catalog is still loading.");
        return;
      }
      const resolved = taskListParamsFromParsedFilter(result.filter, catalog);
      if (!resolved.ok) {
        setParsedFilter(null);
        setParseError(resolved.error);
        return;
      }
      setParsedFilter(result);
      setParseError(null);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid filter query.");
      setParsedFilter(null);
    }
  };

  const handleSaveFilter = async () => {
    if (!filterName.trim() || !query.trim()) return;
    await createSavedFilter({ name: filterName.trim(), query: query.trim() });
    setFilterName("");
    setShowSaveDialog(false);
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;
    await createTag({ name: newTagName.trim(), color: newTagColor });
    setNewTagName("");
  };

  // Resolve names against the live catalog so list requests only carry UUIDs.
  const queryParams = useMemo((): TaskListParams | undefined => {
    if (!parsedFilter || !catalog) return undefined;
    const resolved = taskListParamsFromParsedFilter(parsedFilter.filter, catalog);
    return resolved.ok ? resolved.params : undefined;
  }, [parsedFilter, catalog]);

  const resolveError = useMemo(() => {
    if (!parsedFilter || !catalog) return null;
    const resolved = taskListParamsFromParsedFilter(parsedFilter.filter, catalog);
    return resolved.ok ? null : resolved.error;
  }, [parsedFilter, catalog]);

  const { tasks, loading, error } = useViewTasks(queryParams);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <SlidersHorizontal size={24} className="text-accent-foreground" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Filters & Labels</h1>
      </div>

      {/* Query bar */}
      <div className="mb-6">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (parseError) setParseError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleParse();
            }}
            placeholder='Filter tasks… (e.g., "p1 overdue #work")'
            aria-label="Filter query"
            className="flex-1 px-3 py-2 border border-border rounded-lg bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-focus"
          />
          <button
            onClick={() => void handleParse()}
            className="rounded-md bg-accent-action px-4 py-2 text-sm text-on-accent-action hover:bg-accent-action-hover"
          >
            Filter
          </button>
          {query.trim() && (
            <button
              onClick={() => setShowSaveDialog(true)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-on-surface-secondary hover:bg-surface-secondary"
            >
              <Save size={14} />
              Save
            </button>
          )}
        </div>
        {(parseError || resolveError) && (
          <p role="alert" className="mt-1 text-xs text-error">
            {parseError ?? resolveError}
          </p>
        )}
        {parsedFilter && !resolveError && (
          <p className="mt-1 text-xs text-on-surface-muted" aria-live="polite">
            Filter active: {parsedFilter.filter.statuses.join(", ") || "all statuses"}
            {parsedFilter.filter.priority && ` · P${parsedFilter.filter.priority}`}
            {parsedFilter.filter.overdue && " · overdue"}
            {parsedFilter.filter.project_name && ` · @${parsedFilter.filter.project_name}`}
            {(parsedFilter.filter.tag_names?.length ?? 0) > 0 &&
              ` · ${parsedFilter.filter.tag_names.map((name) => `#${name}`).join(" ")}`}
          </p>
        )}
      </div>

      {/* Save filter dialog */}
      {showSaveDialog && (
        <div className="mb-4 rounded-lg border border-border bg-surface-secondary p-4">
          <h3 className="text-sm font-semibold text-on-surface mb-2">Save Filter</h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={filterName}
              onChange={(e) => setFilterName(e.target.value)}
              placeholder="Filter name"
              className="flex-1 px-3 py-2 border border-border rounded-lg bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-focus"
              aria-label="Filter name"
            />
            <button
              onClick={() => void handleSaveFilter()}
              disabled={!filterName.trim()}
              className="rounded-md bg-accent-action px-4 py-2 text-sm text-on-accent-action disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => setShowSaveDialog(false)}
              className="rounded-md border border-border px-3 py-2 text-sm text-on-surface-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Live results */}
      {parsedFilter && !resolveError && queryParams && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2">
            Results ({tasks.length})
          </h2>
          {loading ? (
            <p className="text-sm text-on-surface-muted" role="status">
              Loading…
            </p>
          ) : error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : (
            <TaskList
              tasks={tasks}
              onToggle={onToggleTask}
              onSelect={onSelectTask}
              selectedTaskId={selectedTaskId}
              selectedTaskIds={selectedTaskIds}
              onMultiSelect={onMultiSelect}
              emptyMessage="No matching tasks"
              todayKey={today}
            />
          )}
        </div>
      )}

      {/* Tags management */}
      <div className="mb-6">
        <h2 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2">
          Tags
        </h2>
        <div className="space-y-0.5">
          {tags.map((tag) => (
            <TagRow key={tag.id} tag={tag} onDelete={() => void deleteTag(tag.id)} />
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            placeholder="New tag name"
            className="flex-1 px-3 py-1.5 border border-border rounded-lg bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-focus"
            aria-label="New tag name"
          />
          <input
            type="color"
            value={newTagColor}
            onChange={(e) => setNewTagColor(e.target.value)}
            aria-label="Tag color"
            className="h-8 w-10 rounded border border-border"
          />
          <button
            onClick={() => void handleCreateTag()}
            disabled={!newTagName.trim()}
            className="flex items-center gap-1 rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action disabled:opacity-50"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Saved filters */}
      <div className="mb-6">
        <h2 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2">
          Saved Filters
        </h2>
        <div className="space-y-0.5">
          {savedFilters.length === 0 ? (
            <p className="text-sm text-on-surface-muted">No saved filters yet.</p>
          ) : (
            savedFilters.map((filter) => (
              <SavedFilterRow
                key={filter.id}
                filter={filter}
                onClick={() => onNavigate({ name: "saved-filter", filterId: filter.id })}
              />
            ))
          )}
        </div>
      </div>

      {/* Templates — full Settings is Phase 4; manage here for Phase 2 */}
      <TemplatesSection templates={templates} tags={tags} />
    </div>
  );
}

function TagRow({ tag, onDelete }: { tag: TagDto; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-secondary transition-colors">
      <Hash size={14} className="text-on-surface-muted flex-shrink-0" />
      <span
        aria-hidden="true"
        className="h-2 w-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: tag.color }}
      />
      <span className="flex-1 text-sm font-mono text-on-surface-secondary">{tag.name}</span>
      <button
        onClick={onDelete}
        aria-label={`Delete tag ${tag.name}`}
        className="text-on-surface-muted hover:text-error transition-colors"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function SavedFilterRow({ filter, onClick }: { filter: SavedFilterDto; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 rounded-lg text-left hover:bg-surface-secondary transition-colors"
    >
      {filter.color && (
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: filter.color }}
        />
      )}
      <span className="flex-1 text-sm text-on-surface">{filter.name}</span>
      <span className="text-xs text-on-surface-muted font-mono truncate">{filter.query}</span>
    </button>
  );
}
