/**
 * Compatibility task state for the Phase 1 Today/Inbox shell.
 * Backed by view-scoped keyset queries + SSE convergence primitives.
 * The next UI wave should prefer useTaskQuery / useCatalog / useMutations directly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommittedEventDto, MutationResponse, TaskDto } from "../api/client";
import {
  ApiError,
  NetworkError,
  completeTask,
  createTask,
  deleteTask,
  generateOperationId,
  hasStoredToken,
  listTasks,
  patchTask,
  subscribeToEvents,
  taskFromCommittedEvent,
  uncompleteTask,
} from "../api/client";
import {
  applyTaskEventToList,
  nextStateFromListSnapshot,
  removeTaskById,
  upsertTaskById,
} from "./useTaskQuery";
import { RefreshCoalescer } from "./liveQuery";
import { isOutcomeUnknown } from "./useMutations";

export type { TaskDto };
export { nextStateFromListSnapshot, removeTaskById, upsertTaskById } from "./useTaskQuery";

export interface TaskState {
  tasks: TaskDto[];
  revision: number;
  asOfDate: string | null;
  loading: boolean;
  error: string | null;
  mutationPhase: "idle" | "pending" | "error" | "outcome-unknown";
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

function applyMutationResult(
  result: MutationResponse,
  appliedRevision: number,
  applyTask: (task: TaskDto, revision: number) => void,
  onDelete?: (taskIds: string[] | undefined, revision: number) => void,
): void {
  const event = result.event;
  if (event.revision < appliedRevision) return;

  if (event.event_type === "task.deleted") {
    onDelete?.(event.affected.task_ids, event.revision);
    return;
  }

  const task = taskFromCommittedEvent(event);
  if (task) {
    applyTask(task, event.revision);
  }
}

/**
 * Manages task list state with SSE-driven convergence for the existing shell.
 * Loads at most one 100-task page (never the full table). Mutations mint one
 * UUID idempotency key per user action and refresh after outcome-unknown failures.
 */
export function useTasks(): TaskState & TaskActions {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [revision, setRevision] = useState(0);
  const [asOfDate, setAsOfDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationPhase, setMutationPhase] = useState<
    "idle" | "pending" | "error" | "outcome-unknown"
  >("idle");

  const pendingOps = useRef(new Set<string>());
  const appliedRevisionRef = useRef(0);
  const tasksRef = useRef<TaskDto[]>([]);
  const coalescerRef = useRef(new RefreshCoalescer());

  const applyListSnapshot = useCallback(
    (snapshot: {
      revision: number;
      tasks: TaskDto[];
      as_of_date: string;
      next_cursor?: string | null;
    }) => {
      const next = nextStateFromListSnapshot(appliedRevisionRef.current, snapshot);
      if (!next) {
        return false;
      }
      appliedRevisionRef.current = next.revision;
      tasksRef.current = next.tasks;
      setTasks(next.tasks);
      setRevision(next.revision);
      setAsOfDate(next.as_of_date);
      return true;
    },
    [],
  );

  const applyMutationTask = useCallback((task: TaskDto, eventRevision: number) => {
    if (eventRevision < appliedRevisionRef.current) {
      return;
    }
    appliedRevisionRef.current = eventRevision;
    setRevision(eventRevision);
    setTasks((prev) => {
      const next = upsertTaskById(prev, task);
      tasksRef.current = next;
      return next;
    });
  }, []);

  const reloadTasks = useCallback(async () => {
    if (!hasStoredToken()) {
      setLoading(false);
      return;
    }

    await coalescerRef.current.run(async () => {
      try {
        // First page only — never walk the full table from this compatibility hook.
        const result = await listTasks({ limit: 100 });
        applyListSnapshot(result);
        setError(null);
      } catch (err) {
        setError(formatError(err));
      } finally {
        setLoading(false);
      }
    });
  }, [applyListSnapshot]);

  useEffect(() => {
    void reloadTasks();
  }, [reloadTasks]);

  const handleEvent = useCallback(
    (event: CommittedEventDto) => {
      pendingOps.current.delete(event.operation_id);
      const result = applyTaskEventToList(tasksRef.current, appliedRevisionRef.current, event);
      if (result.needsRefresh) {
        void reloadTasks();
        return;
      }
      if (result.revision !== appliedRevisionRef.current || result.tasks !== tasksRef.current) {
        appliedRevisionRef.current = result.revision;
        tasksRef.current = result.tasks;
        setTasks(result.tasks);
        setRevision(result.revision);
      }
    },
    [reloadTasks],
  );

  useEffect(() => {
    if (!hasStoredToken()) return;

    const cleanup = subscribeToEvents(
      (sseEvent) => {
        handleEvent(sseEvent.data);
      },
      () => {
        // Durable catch-up on reconnect — one coalesced reload, not a loop.
        void reloadTasks();
      },
      (streamError) => {
        setError(streamError.message);
      },
      appliedRevisionRef.current,
      (scope) => {
        if (scope.tasks) void reloadTasks();
      },
    );

    return cleanup;
  }, [handleEvent, reloadTasks]);

  const runMutation = useCallback(
    async (
      operationId: string,
      execute: () => Promise<MutationResponse>,
      onSuccess: (result: MutationResponse) => void,
    ): Promise<MutationResponse | null> => {
      pendingOps.current.add(operationId);
      setMutationPhase("pending");
      try {
        const result = await execute();
        onSuccess(result);
        setMutationPhase("idle");
        setError(null);
        // When the event asks for a query resync (bulk/cascade), refresh.
        if (result.event.resync.tasks) {
          void reloadTasks();
        }
        return result;
      } catch (err) {
        if (isOutcomeUnknown(err)) {
          setMutationPhase("outcome-unknown");
          setError(formatError(err));
          // Explicit authoritative refresh after ambiguous network failure.
          await reloadTasks();
          return null;
        }
        setMutationPhase("error");
        setError(formatError(err));
        return null;
      } finally {
        pendingOps.current.delete(operationId);
      }
    },
    [reloadTasks],
  );

  const handleCreateTask = useCallback(
    async (title: string, dueDate: string | null): Promise<TaskDto | null> => {
      const operationId = generateOperationId();
      const result = await runMutation(
        operationId,
        () => createTask({ title, due_date: dueDate }, operationId),
        (response) => {
          applyMutationResult(response, appliedRevisionRef.current, applyMutationTask);
        },
      );
      return result ? taskFromCommittedEvent(result.event) : null;
    },
    [applyMutationTask, runMutation],
  );

  const handleUpdateTask = useCallback(
    async (taskId: string, title: string, dueDate: string | null): Promise<TaskDto | null> => {
      const operationId = generateOperationId();
      const result = await runMutation(
        operationId,
        () => patchTask(taskId, { title, due_date: dueDate }, operationId),
        (response) => {
          applyMutationResult(response, appliedRevisionRef.current, applyMutationTask);
        },
      );
      return result ? taskFromCommittedEvent(result.event) : null;
    },
    [applyMutationTask, runMutation],
  );

  const handleToggleComplete = useCallback(
    async (taskId: string): Promise<TaskDto | null> => {
      const current = tasksRef.current.find((t) => t.id === taskId);
      const operationId = generateOperationId();
      const result = await runMutation(
        operationId,
        () =>
          current?.status === "completed"
            ? uncompleteTask(taskId, operationId)
            : completeTask(taskId, operationId),
        (response) => {
          applyMutationResult(response, appliedRevisionRef.current, applyMutationTask);
        },
      );
      return result ? taskFromCommittedEvent(result.event) : null;
    },
    [applyMutationTask, runMutation],
  );

  const handleDeleteTask = useCallback(
    async (taskId: string): Promise<boolean> => {
      const operationId = generateOperationId();
      const result = await runMutation(
        operationId,
        () => deleteTask(taskId, operationId),
        (response) => {
          applyMutationResult(
            response,
            appliedRevisionRef.current,
            applyMutationTask,
            (taskIds, eventRevision) => {
              if (eventRevision >= appliedRevisionRef.current) {
                appliedRevisionRef.current = eventRevision;
                setRevision(eventRevision);
              }
              setTasks((prev) => {
                const ids = taskIds && taskIds.length > 0 ? taskIds : [taskId];
                let next = prev;
                for (const id of ids) {
                  next = removeTaskById(next, id);
                }
                tasksRef.current = next;
                return next;
              });
            },
          );
        },
      );
      return result !== null;
    },
    [applyMutationTask, runMutation],
  );

  const handleRetry = useCallback(() => {
    setError(null);
    setMutationPhase("idle");
    setLoading(true);
    void reloadTasks();
  }, [reloadTasks]);

  return {
    tasks,
    revision,
    asOfDate,
    loading,
    error,
    mutationPhase,
    createTask: handleCreateTask,
    updateTask: handleUpdateTask,
    toggleComplete: handleToggleComplete,
    deleteTask: handleDeleteTask,
    retry: handleRetry,
  };
}

// Re-export NetworkError recognition for tests that mock client modules.
export { NetworkError, isOutcomeUnknown };
