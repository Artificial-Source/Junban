/**
 * App-level SSE subscription hook.
 * Opens one authenticated SSE stream and fans out events to task/catalog hooks.
 * Coalesces reconnect reloads so no hook opens its own stream.
 */
import { useEffect, useRef } from "react";
import { subscribeToEvents, hasStoredToken, type CommittedEventDto } from "../api/client";

export interface SseFanOut {
  onTaskEvent: (event: CommittedEventDto) => void;
  onCatalogEvent: (event: CommittedEventDto) => void;
  onTaskResync: () => void;
  onCatalogResync: () => void;
  onReconnect: () => void;
  onTerminalError: (message: string) => void;
}

export function useSseSubscription(
  fanOut: SseFanOut,
  initialRevision: number,
  enabled: boolean,
): void {
  const fanOutRef = useRef(fanOut);
  fanOutRef.current = fanOut;

  useEffect(() => {
    if (!enabled || !hasStoredToken()) return;

    const cleanup = subscribeToEvents(
      (sseEvent) => {
        const event = sseEvent.data;
        fanOutRef.current.onTaskEvent(event);
        fanOutRef.current.onCatalogEvent(event);
      },
      () => {
        fanOutRef.current.onReconnect();
      },
      (error) => {
        fanOutRef.current.onTerminalError(error.message);
      },
      initialRevision,
      (scope, _reason) => {
        if (scope.tasks) fanOutRef.current.onTaskResync();
        if (scope.catalog) fanOutRef.current.onCatalogResync();
      },
    );

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
