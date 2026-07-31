/**
 * WorkspaceContext: one app-level data hub.
 * Owns the catalog, the SSE subscription, task query fan-out, mutations,
 * undo stack, and toast feedback. Components consume via useWorkspace().
 *
 * No external state-management library — plain React context + hooks.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CatalogResponse, CommittedEventDto, MutationResponse } from "../api/client";
import { hasStoredToken } from "../api/client";
import { useCatalog } from "../hooks/useCatalog";
import { useMutations, type MutationPhase } from "../hooks/useMutations";
import { useToasts, type ShowToastOptions, type ToastEntry } from "../components/Toast";
import { useSseSubscription } from "../hooks/useSseSubscription";

// Session undo/redo stacks: 50 entries max (per context map rule).
// Server undo-of-undo is redo; the browser only stores operation IDs + labels.
const MAX_HISTORY_STACK = 50;

interface HistoryEntry {
  operationId: string;
  label: string;
}

export interface WorkspaceContextValue {
  // Catalog
  catalog: CatalogResponse | null;
  catalogLoading: boolean;
  catalogError: string | null;
  refreshCatalog: () => void;

  // Mutations
  mutationPhase: MutationPhase;
  mutationError: string | null;

  // Undo / redo
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;
  /** Undo latest, or a specific source operation (toast Undo). */
  undo: (sourceOperationId?: string) => Promise<void>;
  redo: () => Promise<void>;

  // Toasts
  toasts: ToastEntry[];
  showToast: (
    kind: "success" | "error" | "info",
    message: string,
    options?: string | null | ShowToastOptions,
  ) => void;
  dismissToast: (id: string) => void;

  // SSE
  sseError: string | null;

  // Task event fan-out registration
  registerTaskEventHandler: (handler: (event: CommittedEventDto) => void) => () => void;
  registerTaskResyncHandler: (handler: () => void) => () => void;

  // Run a mutation with full tracking
  runMutation: (
    execute: (operationId: string) => Promise<MutationResponse>,
    options?: {
      successToast?: string;
      undoLabel?: string;
      onOutcomeUnknown?: (operationId: string) => void | Promise<void>;
    },
  ) => Promise<MutationResponse | null>;

  // Revision tracking
  revision: number;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const {
    catalog,
    loading: catalogLoading,
    error: catalogError,
    refresh: refreshCatalog,
    applyEvent: applyCatalogEventFn,
    requestResync: requestCatalogResync,
  } = useCatalog();

  const { phase: mutationPhase, error: mutationError, run: runRaw, undo: undoRaw } = useMutations();
  const { toasts, show: showToast, dismiss: dismissToast } = useToasts();

  const [sseError, setSseError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  // Refs keep toast/keyboard handlers on the latest stacks without stale closures.
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  undoStackRef.current = undoStack;
  redoStackRef.current = redoStack;

  // Task event handler registry — views register/unregister as they mount.
  const taskEventHandlersRef = useRef(new Set<(event: CommittedEventDto) => void>());
  const taskResyncHandlersRef = useRef(new Set<() => void>());

  const registerTaskEventHandler = useCallback((handler: (event: CommittedEventDto) => void) => {
    taskEventHandlersRef.current.add(handler);
    return () => {
      taskEventHandlersRef.current.delete(handler);
    };
  }, []);

  const registerTaskResyncHandler = useCallback((handler: () => void) => {
    taskResyncHandlersRef.current.add(handler);
    return () => {
      taskResyncHandlersRef.current.delete(handler);
    };
  }, []);

  const onTaskEvent = useCallback((event: CommittedEventDto) => {
    setRevision((prev) => Math.max(prev, event.revision));
    for (const handler of taskEventHandlersRef.current) {
      handler(event);
    }
  }, []);

  const onCatalogEvent = useCallback(
    (event: CommittedEventDto) => {
      setRevision((prev) => Math.max(prev, event.revision));
      applyCatalogEventFn(event);
    },
    [applyCatalogEventFn],
  );

  const onTaskResync = useCallback(() => {
    for (const handler of taskResyncHandlersRef.current) {
      handler();
    }
  }, []);

  const onCatalogResync = useCallback(() => {
    requestCatalogResync();
  }, [requestCatalogResync]);

  const onReconnect = useCallback(() => {
    // On reconnect, SSE client sends Last-Event-ID for catch-up.
    // If catch-up fails, the server sends sync.resync_required which triggers onTaskResync/onCatalogResync.
    // Also force a catalog refresh as a safety net.
    requestCatalogResync();
  }, [requestCatalogResync]);

  const onTerminalError = useCallback((message: string) => {
    setSseError(message);
  }, []);

  // SSE is enabled once we have a token and catalog has loaded at least once.
  const sseEnabled = hasStoredToken();

  useSseSubscription(
    { onTaskEvent, onCatalogEvent, onTaskResync, onCatalogResync, onReconnect, onTerminalError },
    revision,
    sseEnabled,
  );

  /** Fan a committed event through task handlers, then catalog — same path as SSE. */
  const applyOwnCommittedEvent = useCallback(
    (event: CommittedEventDto) => {
      setRevision((prev) => Math.max(prev, event.revision));
      for (const handler of taskEventHandlersRef.current) {
        handler(event);
      }
      if (event.resync.catalog) {
        requestCatalogResync();
      } else {
        applyCatalogEventFn(event);
      }
    },
    [applyCatalogEventFn, requestCatalogResync],
  );

  /** One coalesced task + catalog resync after ambiguous network failure. */
  const resyncAfterOutcomeUnknown = useCallback(() => {
    for (const handler of taskResyncHandlersRef.current) {
      handler();
    }
    requestCatalogResync();
  }, [requestCatalogResync]);

  const runMutation = useCallback(
    async (
      execute: (operationId: string) => Promise<MutationResponse>,
      options?: {
        successToast?: string;
        undoLabel?: string;
        onOutcomeUnknown?: (operationId: string) => void | Promise<void>;
      },
    ): Promise<MutationResponse | null> => {
      const result = await runRaw(execute, {
        onOutcomeUnknown: async (operationId) => {
          // Default: force authoritative task + catalog convergence. Keep the
          // mutation phase as outcome-unknown (no invented optimistic state).
          resyncAfterOutcomeUnknown();
          await options?.onOutcomeUnknown?.(operationId);
        },
      });

      if (result) {
        // A new user mutation invalidates redo; undo of undo remains the only redo path.
        setRedoStack([]);

        // Track undo if label provided.
        if (options?.undoLabel) {
          setUndoStack((prev) => {
            const entry: HistoryEntry = {
              operationId: result.event.operation_id,
              label: options.undoLabel!,
            };
            return [entry, ...prev].slice(0, MAX_HISTORY_STACK);
          });
        }

        // Show success toast if requested.
        if (options?.successToast) {
          showToast(
            "success",
            options.successToast,
            options?.undoLabel ? result.event.operation_id : undefined,
          );
        }

        // Own mutation responses converge through the same handlers as SSE.
        // Monotonic revision checks make a later SSE replay of the same event harmless.
        applyOwnCommittedEvent(result.event);
      }

      return result;
    },
    [runRaw, showToast, applyOwnCommittedEvent, resyncAfterOutcomeUnknown],
  );

  const undo = useCallback(
    async (sourceOperationId?: string): Promise<void> => {
      const stack = undoStackRef.current;
      const entry = sourceOperationId
        ? stack.find((item) => item.operationId === sourceOperationId)
        : stack[0];
      // Toast may name an id; keyboard/palette undo the latest. Prefer the stack
      // entry label when present; still attempt a named id that left the stack.
      const targetId = sourceOperationId ?? entry?.operationId;
      if (!targetId) return;
      const label = entry?.label ?? "Action";

      const result = await undoRaw(targetId, {
        onOutcomeUnknown: async () => {
          resyncAfterOutcomeUnknown();
        },
      });
      if (result) {
        // Remove the exact source entry (not merely the top) so older toasts work.
        setUndoStack((prev) => prev.filter((item) => item.operationId !== targetId));
        // Compensating receipt is redo authority (server undo-of-undo).
        setRedoStack((prev) =>
          [{ operationId: result.event.operation_id, label }, ...prev].slice(0, MAX_HISTORY_STACK),
        );
        showToast("info", `Undone: ${label}`);
        applyOwnCommittedEvent(result.event);
      }
      // Outcome-unknown / error: leave both stacks untouched.
    },
    [undoRaw, showToast, applyOwnCommittedEvent, resyncAfterOutcomeUnknown],
  );

  const redo = useCallback(async (): Promise<void> => {
    const entry = redoStackRef.current[0];
    if (!entry) return;

    const result = await undoRaw(entry.operationId, {
      onOutcomeUnknown: async () => {
        resyncAfterOutcomeUnknown();
      },
    });
    if (result) {
      setRedoStack((prev) => prev.slice(1));
      // Redo's compensating receipt returns the action to undo authority.
      setUndoStack((prev) =>
        [{ operationId: result.event.operation_id, label: entry.label }, ...prev].slice(
          0,
          MAX_HISTORY_STACK,
        ),
      );
      showToast("info", `Redone: ${entry.label}`);
      applyOwnCommittedEvent(result.event);
    }
    // Outcome-unknown / error: leave both stacks untouched.
  }, [undoRaw, showToast, applyOwnCommittedEvent, resyncAfterOutcomeUnknown]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      catalog,
      catalogLoading,
      catalogError,
      refreshCatalog,
      mutationPhase,
      mutationError,
      undoStack,
      redoStack,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undo,
      redo,
      toasts,
      showToast,
      dismissToast,
      sseError,
      registerTaskEventHandler,
      registerTaskResyncHandler,
      runMutation,
      revision,
    }),
    [
      catalog,
      catalogLoading,
      catalogError,
      refreshCatalog,
      mutationPhase,
      mutationError,
      undoStack,
      redoStack,
      undo,
      redo,
      toasts,
      showToast,
      dismissToast,
      sseError,
      registerTaskEventHandler,
      registerTaskResyncHandler,
      runMutation,
      revision,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return ctx;
}
