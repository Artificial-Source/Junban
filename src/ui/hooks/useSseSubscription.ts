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
  onSettingsEvent?: (event: CommittedEventDto) => void;
  onTaskResync: () => void | Promise<void>;
  onCatalogResync: () => void | Promise<void>;
  onSettingsResync?: () => void | Promise<void>;
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
        fanOutRef.current.onSettingsEvent?.(event);
      },
      () => {
        fanOutRef.current.onReconnect();
      },
      (error) => {
        fanOutRef.current.onTerminalError(error.message);
      },
      initialRevision,
      async (scope, _reason) => {
        await Promise.all([
          scope.tasks ? fanOutRef.current.onTaskResync() : undefined,
          scope.catalog ? fanOutRef.current.onCatalogResync() : undefined,
          scope.settings ? fanOutRef.current.onSettingsResync?.() : undefined,
        ]);
      },
    );

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
