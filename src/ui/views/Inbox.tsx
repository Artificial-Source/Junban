/**
 * Inbox view: unprojected pending tasks + recently completed.
 * Uses server view preset "inbox" which returns pending first plus
 * recently completed from the last 14 calendar days.
 */
import { useMemo } from "react";
import { Inbox as InboxIcon } from "lucide-react";
import type { TagDto } from "../api/client";
import { TaskInput } from "../components/TaskInput";
import { TaskList } from "../components/TaskList";
import { useToday } from "../hooks/useToday";
import { useViewTasks } from "../hooks/useViewTasks";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useHierarchyActions } from "../hooks/useHierarchyActions";
import { useWorkspace } from "../context/WorkspaceContext";

interface InboxProps {
  onToggleTask: (id: string) => Promise<boolean>;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    orderedIds: string[],
  ) => void;
  autoFocusTrigger?: number;
}

export function Inbox({
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  autoFocusTrigger,
}: InboxProps) {
  const today = useToday();
  const { catalog } = useWorkspace();
  const { parseQuickEntry, createFromQuickEntry } = useTaskMutations();
  const { tasks, loading, error, reload } = useViewTasks({ view: "inbox", limit: 100 });

  const tagMap = useMemo(() => {
    const map = new Map<string, TagDto>();
    for (const tag of catalog?.tags ?? []) map.set(tag.id, tag);
    return map;
  }, [catalog]);

  const inboxTasks = useMemo(
    () =>
      tasks.sort((a, b) => {
        if (a.status === "completed" && b.status !== "completed") return 1;
        if (a.status !== "completed" && b.status === "completed") return -1;
        return 0;
      }),
    [tasks],
  );

  const { indent, outdent } = useHierarchyActions(inboxTasks);
  const pendingCount = inboxTasks.filter((t) => t.status === "pending").length;

  const handleParseAndCreate = async (input: string): Promise<boolean> => {
    const parsed = await parseQuickEntry(input);
    // Inbox tasks have no project — don't default due_date so they stay in inbox.
    const result = await createFromQuickEntry(parsed);
    if (!result) {
      throw new Error("The task could not be created.");
    }
    return true;
  };

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-4 md:mb-6">
          <InboxIcon size={24} className="text-accent-foreground" />
          <h1 className="text-xl md:text-2xl font-bold text-on-surface">Inbox</h1>
        </div>
        <p className="text-sm text-on-surface-muted" role="status">
          Loading tasks…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4">
        <p className="text-sm font-medium text-error">Could not load inbox: {error}</p>
        <button
          onClick={reload}
          className="mt-2 rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <InboxIcon size={24} className="text-accent-foreground" />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">Inbox</h1>
        <span className="text-sm text-on-surface-secondary">
          {pendingCount} {pendingCount === 1 ? "task" : "tasks"}
        </span>
      </div>
      <TaskInput onParseAndCreate={handleParseAndCreate} autoFocusTrigger={autoFocusTrigger} />
      <TaskList
        tasks={inboxTasks}
        onToggle={onToggleTask}
        onSelect={onSelectTask}
        selectedTaskId={selectedTaskId}
        selectedTaskIds={selectedTaskIds}
        onMultiSelect={onMultiSelect}
        emptyMessage="Your inbox is empty. Add a task above!"
        todayKey={today}
        tagMap={tagMap}
        onIndent={indent}
        onOutdent={outdent}
      />
    </div>
  );
}
