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
 * Manages task list state with SSE-driven convergence.
 * Mutations generate one UUID idempotency key per logical operation,
 * retain it across transport retry, and reload the list after relevant events.
 */
export function useTasks(): TaskState & TaskActions {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track pending operation IDs so SSE events from our own mutations
  // don't cause redundant list reloads.
  const pendingOps = useRef(new Set<string>());
  // Track the last revision applied from SSE to avoid reload waterfalls.
  const lastAppliedRevision = useRef(0);

  const reloadTasks = useCallback(async () => {
    if (!hasStoredToken()) {
      setLoading(false);
      return;
    }
    try {
      const result = await listTasks();
      setTasks(result.tasks);
      setRevision(result.revision);
      lastAppliedRevision.current = result.revision;
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

        // Reload the task list to converge with the server state.
        // Dedup by revision: only reload if we haven't already seen this revision.
        if (event.data.revision > lastAppliedRevision.current) {
          lastAppliedRevision.current = event.data.revision;
          void reloadTasks();
        }
      },
      () => {
        // On reconnect, reload to catch any missed events
        void reloadTasks();
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
          // Optimistic update: add the task to the list immediately
          setTasks((prev) => [...prev, result.task!]);
          setRevision(result.event.revision);
          lastAppliedRevision.current = result.event.revision;
        }
        return result.task ?? null;
      } catch (err) {
        pendingOps.current.delete(operationId);
        setError(formatError(err));
        return null;
      }
    },
    [],
  );

  const handleUpdateTask = useCallback(
    async (taskId: string, title: string, dueDate: string | null): Promise<TaskDto | null> => {
      const operationId = generateOperationId();
      pendingOps.current.add(operationId);
      try {
        const result = await replaceTask(taskId, { title, due_date: dueDate }, operationId);
        if (result.task) {
          setTasks((prev) => prev.map((t) => (t.id === taskId ? result.task! : t)));
          setRevision(result.event.revision);
          lastAppliedRevision.current = result.event.revision;
        }
        return result.task ?? null;
      } catch (err) {
        pendingOps.current.delete(operationId);
        setError(formatError(err));
        return null;
      }
    },
    [],
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
          setTasks((prev) => prev.map((t) => (t.id === taskId ? result.task! : t)));
          setRevision(result.event.revision);
          lastAppliedRevision.current = result.event.revision;
        }
        return result.task ?? null;
      } catch (err) {
        pendingOps.current.delete(operationId);
        setError(formatError(err));
        return null;
      }
    },
    [tasks],
  );

  const handleDeleteTask = useCallback(async (taskId: string): Promise<boolean> => {
    const operationId = generateOperationId();
    pendingOps.current.add(operationId);
    try {
      await deleteTask(taskId, operationId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      return true;
    } catch (err) {
      pendingOps.current.delete(operationId);
      setError(formatError(err));
      return false;
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
