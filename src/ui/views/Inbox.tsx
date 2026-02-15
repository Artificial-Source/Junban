import { useState, useMemo, useEffect } from "react";
import { Inbox as InboxIcon } from "lucide-react";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import { QueryBar } from "../components/QueryBar.js";
import { filterTasks } from "../../core/filters.js";
import { parseQuery } from "../../core/query-parser.js";
import type { ParsedQuery } from "../../core/query-parser.js";
import type { Task } from "../../core/types.js";

interface InboxProps {
  tasks: Task[];
  onCreateTask: (parsed: {
    title: string;
    priority: number | null;
    tags: string[];
    project: string | null;
    dueDate: Date | null;
    dueTime: boolean;
  }) => void;
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  onReorder?: (orderedIds: string[]) => void;
  queryText?: string;
  onQueryTextChange?: (value: string) => void;
}

export function Inbox({
  tasks,
  onCreateTask,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onReorder,
  queryText,
  onQueryTextChange,
}: InboxProps) {
  const [query, setQuery] = useState<ParsedQuery | null>(null);
  const [inboxViewTimeMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (queryText === undefined) return;
    if (!queryText.trim()) {
      setQuery(null);
      return;
    }
    setQuery(parseQuery(queryText));
  }, [queryText]);

  const inboxTasks = useMemo(() => {
    const cutoffMs = inboxViewTimeMs - 14 * 24 * 60 * 60 * 1000;
    const isRecentCompletedTask = (t: Task): boolean => {
      if (t.status !== "completed") return false;
      if (!t.completedAt) return true;
      const completedAtMs = Date.parse(t.completedAt);
      if (Number.isNaN(completedAtMs)) return true;
      return completedAtMs >= cutoffMs;
    };

    if (!query) {
      return tasks.filter(
        (t) => !t.projectId && (t.status === "pending" || isRecentCompletedTask(t)),
      );
    }

    const hasExplicitStatusFilter = Boolean(query.filter.status);
    const base = tasks.filter((t) => {
      if (t.projectId) return false;
      if (hasExplicitStatusFilter) return true;
      return t.status === "pending" || isRecentCompletedTask(t);
    });

    return filterTasks(base, query.filter);
  }, [tasks, query, inboxViewTimeMs]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <InboxIcon size={24} className="text-accent" />
        <h1 className="text-2xl font-bold text-on-surface">Inbox</h1>
        <span className="text-sm text-on-surface-muted">{inboxTasks.length} tasks</span>
      </div>
      <TaskInput onSubmit={onCreateTask} />
      <div className="mb-3">
        <QueryBar value={queryText} onValueChange={onQueryTextChange} onQueryChange={setQuery} />
      </div>
      <TaskList
        tasks={inboxTasks}
        onToggle={onToggleTask}
        onSelect={onSelectTask}
        selectedTaskId={selectedTaskId}
        emptyMessage={
          query ? "No tasks match your query." : "Your inbox is empty. Add a task above!"
        }
        selectedTaskIds={selectedTaskIds}
        onMultiSelect={onMultiSelect}
        onReorder={onReorder}
      />
    </div>
  );
}
