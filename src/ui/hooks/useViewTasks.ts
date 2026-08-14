/**
 * View-scoped task query hook integrated with the workspace SSE fan-out.
 * Registers with the workspace to receive task events and resync signals.
 * Uses the existing useTaskQuery for keyset pagination and monotonic snapshots.
 *
 * Handlers always call through refs so a resync after the query identity changes
 * (e.g. Project A → Project B) uses the current query, not the mount-time one.
 */
import { useEffect, useMemo, useRef } from "react";
import type { TaskListParams, TaskDto } from "../api/client";
import { useTaskQuery } from "./useTaskQuery";
import { useWorkspace } from "../context/WorkspaceContext";

export function useViewTasks(params?: TaskListParams): {
  tasks: TaskDto[];
  revision: number;
  asOfDate: string | null;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  reload: () => void;
  loadMore: () => Promise<void>;
} {
  const { registerTaskEventHandler, registerTaskResyncHandler } = useWorkspace();
  const query = useTaskQuery(params);

  const applyEventRef = useRef(query.applyEvent);
  const requestResyncRef = useRef(query.requestResync);
  applyEventRef.current = query.applyEvent;
  requestResyncRef.current = query.requestResync;

  // Register event handler for SSE fan-out (and own-mutation fan-out).
  useEffect(() => {
    const unregister = registerTaskEventHandler((event) => {
      applyEventRef.current(event);
    });
    return unregister;
  }, [registerTaskEventHandler]);

  // Register resync handler.
  useEffect(() => {
    const unregister = registerTaskResyncHandler(() => requestResyncRef.current());
    return unregister;
  }, [registerTaskResyncHandler]);

  return useMemo(
    () => ({
      tasks: query.tasks,
      revision: query.revision,
      asOfDate: query.asOfDate,
      nextCursor: query.nextCursor,
      loading: query.loading,
      loadingMore: query.loadingMore,
      error: query.error,
      reload: query.reload,
      loadMore: query.loadMore,
    }),
    [query],
  );
}
