/**
 * Task state management with SSE convergence.
 * Uses local React state/hooks; no external state framework.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskDto } from "../api/client";
import {
  ApiError,
  completeTask,
  createTask,
  deleteTask,
  generateOperationId,
  hasStoredToken,
  listTasks,
  replaceTask,
  subscribeToEvents,
  uncompleteTask,
} from "../api/client";

export type { TaskDto };

export interface TaskState {
  tasks: TaskDto[];
  revision: number;
  loading: boolean;
  error: string | null;
}

export interface TaskActions {
  createTask: (title: string, dueDate: string | null) => Promise<TaskDto | null>;
  updateTask: (taskId: string, title: string, dueDate: string | null) => Promise<TaskDto | null>;
  toggleComplete: (taskId: string) => Promise<TaskDto | null>;
  deleteTask: (taskId: string) => Promise<boolean>;
  retry: () => void;
}

/** Format an error message from an API or network error. */
export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred";
}

/**
 * Choose whether an authoritative list snapshot may replace local state.
 * Equal revisions are allowed so a snapshot can confirm a mutation at the same head.
 */
export function nextStateFromListSnapshot(
  currentRevision: number,
  snapshot: { revision: number; tasks: TaskDto[] },
): { revision: number; tasks: TaskDto[] } | null {
  if (snapshot.revision < currentRevision) {
    return null;
  }
  return { revision: snapshot.revision, tasks: snapshot.tasks };
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

/**
 * Manages task list state with SSE-driven convergence.
 * Mutations generate one UUID idempotency key per logical operation,
 * retain it across transport retry, and reload the list after relevant events.
 *
 * List snapshots apply monotonically by server revision. Concurrent reloads
 * coalesce to one in-flight fetch plus at most one follow-up. Mutation task
 * payloads upsert by task id so an own-create SSE/list result cannot duplicate
 * when the mutation response arrives later.
 */
export function useTasks(): TaskState & TaskActions {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track pending operation IDs so SSE handlers can clear own-mutation receipts.
  const pendingOps = useRef(new Set<string>());
  // Highest authoritative revision already applied to local state.
  const appliedRevisionRef = useRef(0);
  // Coalesce reloads: one in flight, one queued follow-up max.
  const reloadInFlightRef = useRef(false);
  const reloadQueuedRef = useRef(false);

  const applyListSnapshot = useCallback((snapshotRevision: number, snapshotTasks: TaskDto[]) => {
    const next = nextStateFromListSnapshot(appliedRevisionRef.current, {
      revision: snapshotRevision,
      tasks: snapshotTasks,
    });
    if (!next) {
      return false;
    }
    appliedRevisionRef.current = next.revision;
    setTasks(next.tasks);
    setRevision(next.revision);
    return true;
  }, []);

  const applyMutationTask = useCallback((task: TaskDto, eventRevision: number) => {
    if (eventRevision < appliedRevisionRef.current) {
      // A newer authoritative snapshot already won; do not regress task fields.
      return;
    }
    appliedRevisionRef.current = eventRevision;
    setRevision(eventRevision);
    setTasks((prev) => upsertTaskById(prev, task));
  }, []);

  const reloadTasks = useCallback(async () => {
    if (!hasStoredToken()) {
      setLoading(false);
      return;
    }

    if (reloadInFlightRef.current) {
      reloadQueuedRef.current = true;
      return;
    }

    reloadInFlightRef.current = true;
    try {
      do {
        reloadQueuedRef.current = false;
        try {
          const result = await listTasks();
          applyListSnapshot(result.revision, result.tasks);
          setError(null);
        } catch (err) {
          setError(formatError(err));
        } finally {
          setLoading(false);
        }
      } while (reloadQueuedRef.current);
    } finally {
      reloadInFlightRef.current = false;
    }
  }, [applyListSnapshot]);

  // Initial load
  useEffect(() => {
    void reloadTasks();
  }, [reloadTasks]);

  // SSE subscription with reconnect and dedup
  useEffect(() => {
    if (!hasStoredToken()) return;

    const cleanup = subscribeToEvents(
      (event) => {
        // If this event came from our own pending operation, clear it.
        pendingOps.current.delete(event.data.operation_id);

        // Reload when the stream is ahead of applied state. Do not advance the
        // applied revision here — only list/mutation payloads are authoritative.
        if (event.data.revision > appliedRevisionRef.current) {
          void reloadTasks();
        }
      },
      () => {
        // On reconnect, reload to catch any missed events
        void reloadTasks();
      },
      (streamError) => {
        setError(streamError.message);
      },
      revision,
    );

    return cleanup;
    // revision is intentionally not in deps — we don't want to resubscribe
    // every time the revision updates; the SSE stream tracks its own cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStoredToken()]);

  const handleCreateTask = useCallback(
    async (title: string, dueDate: string | null): Promise<TaskDto | null> => {
      const operationId = generateOperationId();
      pendingOps.current.add(operationId);
      try {
        const result = await createTask({ title, due_date: dueDate }, operationId);
        if (result.task) {
          applyMutationTask(result.task, result.event.revision);
        }
        return result.task ?? null;
      } catch (err) {
        setError(formatError(err));
        return null;
      } finally {
        pendingOps.current.delete(operationId);
      }
    },
    [applyMutationTask],
  );

  const handleUpdateTask = useCallback(
    async (taskId: string, title: string, dueDate: string | null): Promise<TaskDto | null> => {
      const operationId = generateOperationId();
      pendingOps.current.add(operationId);
      try {
        const result = await replaceTask(taskId, { title, due_date: dueDate }, operationId);
        if (result.task) {
          applyMutationTask(result.task, result.event.revision);
        }
        return result.task ?? null;
      } catch (err) {
        setError(formatError(err));
        return null;
      } finally {
        pendingOps.current.delete(operationId);
      }
    },
    [applyMutationTask],
  );

  const handleToggleComplete = useCallback(
    async (taskId: string): Promise<TaskDto | null> => {
      const current = tasks.find((t) => t.id === taskId);
      const operationId = generateOperationId();
      pendingOps.current.add(operationId);
      try {
        const result =
          current?.status === "completed"
            ? await uncompleteTask(taskId, operationId)
            : await completeTask(taskId, operationId);
        if (result.task) {
          applyMutationTask(result.task, result.event.revision);
        }
        return result.task ?? null;
      } catch (err) {
        setError(formatError(err));
        return null;
      } finally {
        pendingOps.current.delete(operationId);
      }
    },
    [applyMutationTask, tasks],
  );

  const handleDeleteTask = useCallback(async (taskId: string): Promise<boolean> => {
    const operationId = generateOperationId();
    pendingOps.current.add(operationId);
    try {
      const result = await deleteTask(taskId, operationId);
      if (result.event.revision >= appliedRevisionRef.current) {
        appliedRevisionRef.current = result.event.revision;
        setRevision(result.event.revision);
      }
      setTasks((prev) => removeTaskById(prev, taskId));
      return true;
    } catch (err) {
      setError(formatError(err));
      return false;
    } finally {
      pendingOps.current.delete(operationId);
    }
  }, []);

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    void reloadTasks();
  }, [reloadTasks]);

  return {
    tasks,
    revision,
    loading,
    error,
    createTask: handleCreateTask,
    updateTask: handleUpdateTask,
    toggleComplete: handleToggleComplete,
    deleteTask: handleDeleteTask,
    retry: handleRetry,
  };
}
