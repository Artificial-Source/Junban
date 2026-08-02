/**
 * View-scoped task query with keyset pagination and monotonic SSE convergence.
 * Never fetches the full task table — pages are capped at 100.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommittedEventDto, TaskDto, TaskListParams, TaskListResponse } from "../api/client";
import {
  ApiError,
  TASK_PAGE_LIMIT,
  hasStoredToken,
  listTasks,
  shouldPatchTaskFromEvent,
  taskFromCommittedEvent,
} from "../api/client";
import { nextStateFromRevisionSnapshot, RefreshCoalescer, stableQueryKey } from "./liveQuery";

export type { TaskDto, TaskListParams };

export interface TaskQueryState {
  tasks: TaskDto[];
  revision: number;
  asOfDate: string | null;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export function formatQueryError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}

/**
 * Choose whether an authoritative list snapshot may replace local state.
 * Equal revisions are allowed so a snapshot can confirm a mutation at the same head.
 */
export function nextStateFromListSnapshot(
  currentRevision: number,
  snapshot: { revision: number; tasks: TaskDto[]; as_of_date: string; next_cursor?: string | null },
): {
  revision: number;
  tasks: TaskDto[];
  as_of_date: string;
  next_cursor: string | null;
} | null {
  const next = nextStateFromRevisionSnapshot(currentRevision, {
    revision: snapshot.revision,
    value: snapshot,
  });
  if (!next) return null;
  return {
    revision: next.value.revision,
    tasks: next.value.tasks,
    as_of_date: next.value.as_of_date,
    next_cursor: next.value.next_cursor ?? null,
  };
}

/** Insert or replace a task by id so duplicate create/update deliveries stay idempotent. */
export function upsertTaskById(tasks: TaskDto[], task: TaskDto): TaskDto[] {
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) {
    return [...tasks, task];
  }
  if (tasks[index] === task) {
    return tasks;
  }
  const next = tasks.slice();
  next[index] = task;
  return next;
}

/** Remove a task by id; no-op when the id is already absent. */
export function removeTaskById(tasks: TaskDto[], taskId: string): TaskDto[] {
  const next = tasks.filter((task) => task.id !== taskId);
  return next.length === tasks.length ? tasks : next;
}

export function removeTasksByIds(tasks: TaskDto[], taskIds: string[] | undefined): TaskDto[] {
  if (!taskIds || taskIds.length === 0) return tasks;
  const drop = new Set(taskIds);
  const next = tasks.filter((task) => !drop.has(task.id));
  return next.length === tasks.length ? tasks : next;
}

function sameTagIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left);
  if (ids.size !== right.length) return false;
  return right.every((id) => ids.has(id));
}

/**
 * Fields that can change whether a task belongs in a view/filter query.
 * When any of these differ we refuse a blind upsert and ask for one coalesced refresh
 * instead of re-implementing server query semantics in the client.
 */
export function viewMembershipFieldsChanged(previous: TaskDto, next: TaskDto): boolean {
  return (
    // Title/description participate in free-text search; sort_order owns the
    // default list position. Refresh rather than retaining a stale query row.
    previous.title !== next.title ||
    previous.description !== next.description ||
    previous.sort_order !== next.sort_order ||
    previous.status !== next.status ||
    previous.project_id !== next.project_id ||
    previous.section_id !== next.section_id ||
    previous.parent_id !== next.parent_id ||
    previous.someday !== next.someday ||
    previous.due_date !== next.due_date ||
    previous.completed_at !== next.completed_at ||
    previous.priority !== next.priority ||
    !sameTagIds(previous.tag_ids, next.tag_ids)
  );
}

function normalizeParams(params: TaskListParams | undefined): TaskListParams {
  return {
    ...params,
    limit: Math.min(params?.limit ?? TASK_PAGE_LIMIT, TASK_PAGE_LIMIT),
  };
}

export function applyTaskEventToList(
  tasks: TaskDto[],
  revision: number,
  event: CommittedEventDto,
): { tasks: TaskDto[]; revision: number; needsRefresh: boolean } {
  if (event.revision < revision) {
    return { tasks, revision, needsRefresh: false };
  }

  if (event.event_type === "task.deleted") {
    return {
      tasks: removeTasksByIds(tasks, event.affected.task_ids),
      revision: event.revision,
      needsRefresh: event.resync.tasks,
    };
  }

  if (event.resync.tasks) {
    return { tasks, revision, needsRefresh: true };
  }

  if (!shouldPatchTaskFromEvent(event)) {
    return {
      tasks,
      revision: Math.max(revision, event.revision),
      needsRefresh: false,
    };
  }

  const task = taskFromCommittedEvent(event);
  if (!task) {
    return {
      tasks,
      revision: Math.max(revision, event.revision),
      needsRefresh: false,
    };
  }

  const index = tasks.findIndex((item) => item.id === task.id);
  if (index === -1) {
    // Create/restore/template/move-in: membership is server-owned — one coalesced refresh.
    return { tasks, revision: event.revision, needsRefresh: true };
  }

  if (viewMembershipFieldsChanged(tasks[index]!, task)) {
    // Status/project/due/etc. may drop or keep the row; do not guess — refresh the query.
    return { tasks, revision: event.revision, needsRefresh: true };
  }

  return {
    tasks: upsertTaskById(tasks, task),
    revision: event.revision,
    needsRefresh: false,
  };
}

export function useTaskQuery(params?: TaskListParams): TaskQueryState & {
  reload: () => void;
  loadMore: () => Promise<void>;
  applyEvent: (event: CommittedEventDto) => void;
  requestResync: () => Promise<void>;
  replaceTasks: (tasks: TaskDto[], revision: number) => void;
} {
  const queryKey = stableQueryKey(params as Record<string, unknown> | undefined);
  // Recreate normalized params only when the stable key changes (ignore object identity).
  const normalized = useMemo(() => normalizeParams(params), [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [revision, setRevision] = useState(0);
  const [asOfDate, setAsOfDate] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appliedRevisionRef = useRef(0);
  const tasksRef = useRef<TaskDto[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const coalescerRef = useRef(new RefreshCoalescer());
  const loadMoreInFlightRef = useRef(false);

  const applyListSnapshot = useCallback(
    (snapshot: TaskListResponse, mode: "replace" | "append") => {
      if (mode === "replace") {
        const next = nextStateFromListSnapshot(appliedRevisionRef.current, {
          revision: snapshot.revision,
          tasks: snapshot.tasks,
          as_of_date: snapshot.as_of_date,
          next_cursor: snapshot.next_cursor,
        });
        if (!next) return false;
        appliedRevisionRef.current = next.revision;
        tasksRef.current = next.tasks;
        nextCursorRef.current = next.next_cursor;
        setTasks(next.tasks);
        setRevision(next.revision);
        setAsOfDate(next.as_of_date);
        setNextCursor(next.next_cursor);
        return true;
      }

      // Append pages must not regress revision; allow equal or newer.
      if (snapshot.revision < appliedRevisionRef.current) {
        return false;
      }
      appliedRevisionRef.current = snapshot.revision;
      const merged = snapshot.tasks.reduce(
        (acc, task) => upsertTaskById(acc, task),
        tasksRef.current,
      );
      tasksRef.current = merged;
      nextCursorRef.current = snapshot.next_cursor ?? null;
      setTasks(merged);
      setRevision(snapshot.revision);
      setAsOfDate(snapshot.as_of_date);
      setNextCursor(snapshot.next_cursor ?? null);
      return true;
    },
    [],
  );

  const reloadStrict = useCallback(async () => {
    if (!hasStoredToken()) {
      setLoading(false);
      return;
    }
    await coalescerRef.current.run(async () => {
      try {
        const snapshot = await listTasks({ ...normalized, cursor: undefined });
        applyListSnapshot(snapshot, "replace");
        setError(null);
      } catch (err) {
        setError(formatQueryError(err));
        throw err;
      } finally {
        setLoading(false);
      }
    });
  }, [applyListSnapshot, normalized]);

  const reload = useCallback(async () => {
    try {
      await reloadStrict();
    } catch {
      // Ordinary view refreshes expose the error in state; reset handling uses strict reload.
    }
  }, [reloadStrict]);

  // Reset and load when the query identity changes.
  useEffect(() => {
    appliedRevisionRef.current = 0;
    tasksRef.current = [];
    nextCursorRef.current = null;
    setTasks([]);
    setRevision(0);
    setAsOfDate(null);
    setNextCursor(null);
    setLoading(true);
    setError(null);
    void reload();
  }, [queryKey, reload]);

  const loadMore = useCallback(async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadMoreInFlightRef.current || !hasStoredToken()) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    try {
      const snapshot = await listTasks({ ...normalized, cursor });
      applyListSnapshot(snapshot, "append");
      setError(null);
    } catch (err) {
      setError(formatQueryError(err));
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [applyListSnapshot, normalized]);

  const applyEvent = useCallback(
    (event: CommittedEventDto) => {
      const result = applyTaskEventToList(tasksRef.current, appliedRevisionRef.current, event);
      if (result.needsRefresh) {
        void reload();
        return;
      }
      if (result.revision !== appliedRevisionRef.current || result.tasks !== tasksRef.current) {
        appliedRevisionRef.current = result.revision;
        tasksRef.current = result.tasks;
        setTasks(result.tasks);
        setRevision(result.revision);
      }
    },
    [reload],
  );

  const replaceTasks = useCallback((nextTasks: TaskDto[], nextRevision: number) => {
    if (nextRevision < appliedRevisionRef.current) return;
    appliedRevisionRef.current = nextRevision;
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    setRevision(nextRevision);
  }, []);

  return {
    tasks,
    revision,
    asOfDate,
    nextCursor,
    loading,
    loadingMore,
    error,
    reload: () => {
      setError(null);
      setLoading(true);
      void reload();
    },
    loadMore,
    applyEvent,
    requestResync: reloadStrict,
    replaceTasks,
  };
}
