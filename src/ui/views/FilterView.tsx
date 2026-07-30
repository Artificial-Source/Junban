/**
 * Saved filter result view: evaluates a saved filter query and shows results.
 */
import { useState, useMemo, useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { TaskListParams } from "../api/client";
import { parseFilter } from "../api/client";
import { useWorkspace } from "../context/WorkspaceContext";
import { useViewTasks } from "../hooks/useViewTasks";
import { TaskList } from "../components/TaskList";
import { useToday } from "../hooks/useToday";
import { taskListParamsFromParsedFilter } from "../lib/filterQueryParams";

interface FilterViewProps {
  filterId: string;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    orderedIds: string[],
  ) => void;
  onToggleTask: (id: string) => Promise<boolean>;
}

export function FilterView({
  filterId,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onToggleTask,
}: FilterViewProps) {
  const { catalog } = useWorkspace();
  const today = useToday();
  const [parseError, setParseError] = useState<string | null>(null);

  const savedFilter = useMemo(
    () => catalog?.saved_filters.find((f) => f.id === filterId) ?? null,
    [catalog, filterId],
  );

  const [queryParams, setQueryParams] = useState<TaskListParams | undefined>(undefined);

  useEffect(() => {
    if (!savedFilter || !catalog) return;
    setParseError(null);
    setQueryParams(undefined);
    let cancelled = false;
    void parseFilter({ input: savedFilter.query })
      .then((result) => {
        if (cancelled) return;
        const resolved = taskListParamsFromParsedFilter(result.filter, catalog);
        if (!resolved.ok) {
          setParseError(resolved.error);
          setQueryParams(undefined);
          return;
        }
        setQueryParams(resolved.params);
      })
      .catch((err) => {
        if (cancelled) return;
        setParseError(err instanceof Error ? err.message : "Invalid filter query.");
        setQueryParams(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [savedFilter, catalog]);

  const { tasks, loading, error } = useViewTasks(queryParams);

  if (!savedFilter) {
    return (
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Filter not found</h1>
        <p className="mt-2 text-sm text-on-surface-muted">
          This saved filter may have been deleted.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <SlidersHorizontal size={24} className="text-accent-foreground" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">{savedFilter.name}</h1>
      </div>
      <p className="text-sm text-on-surface-muted mb-4 font-mono">{savedFilter.query}</p>

      {parseError && (
        <p role="alert" className="mb-4 text-sm text-error">
          {parseError}
        </p>
      )}

      {!parseError && loading ? (
        <p className="text-sm text-on-surface-muted" role="status">
          Loading…
        </p>
      ) : !parseError && error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : !parseError ? (
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
      ) : null}
    </div>
  );
}
