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
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AppSettingsResponse,
  CatalogResponse,
  CommittedEventDto,
  MutationResponse,
  PatchSettingsRequest,
} from "../api/client";
import {
  generateOperationId,
  getSettings,
  hasStoredToken,
  NetworkError,
  patchSettings,
} from "../api/client";
import { useCatalog } from "../hooks/useCatalog";
import { useMutations, isOutcomeUnknown, type MutationPhase } from "../hooks/useMutations";
import { useToasts, type ShowToastOptions, type ToastEntry } from "../components/Toast";
import { useSseSubscription } from "../hooks/useSseSubscription";
import { setConfirmedDateTimePreferences } from "../lib/dateTimePreferences";
import { applyAppearance } from "../themes/manager";

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
  /**
   * After authoritative restore cutover (`restart_required: true`), suppress
   * realtime terminal errors and disconnect the subscription until reload.
   * The server is fail-closed; retry banners would contradict DataTab status.
   */
  enterRestartRequired: () => void;

  // Task event fan-out registration
  registerTaskEventHandler: (handler: (event: CommittedEventDto) => void) => () => void;
  registerTaskResyncHandler: (handler: () => void | Promise<void>) => () => void;

  // Run a mutation with full tracking
  runMutation: (
    execute: (operationId: string) => Promise<MutationResponse>,
    options?: {
      successToast?: string;
      undoLabel?: string;
      onOutcomeUnknown?: (operationId: string) => void | Promise<void>;
    },
  ) => Promise<MutationResponse | null>;

  // Settings (Phase 4)
  settings: AppSettingsResponse | null;
  settingsLoading: boolean;
  settingsError: string | null;
  refreshSettings: () => Promise<void>;
  /** Persists a settings patch. Throws ApiError on validation/server failure. */
  saveSettings: (patch: PatchSettingsRequest) => Promise<MutationResponse>;

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
  // Ref is the race-safe gate: terminal SSE callbacks can fire before React re-renders.
  const restartRequiredRef = useRef(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [settings, setSettings] = useState<AppSettingsResponse | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // Refs keep toast/keyboard handlers on the latest stacks without stale closures.
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  undoStackRef.current = undoStack;
  redoStackRef.current = redoStack;

  // Task event handler registry — views register/unregister as they mount.
  const taskEventHandlersRef = useRef(new Set<(event: CommittedEventDto) => void>());
  const taskResyncHandlersRef = useRef(new Set<() => void | Promise<void>>());

  const applySettingsPayload = useCallback((next: AppSettingsResponse) => {
    setSettings(next);
    // Immutable visual fixtures own their explicit theme/appearance presentation.
    // Normal runtime still applies only the server-confirmed payload.
    if (!new URLSearchParams(window.location.search).has("visual-fixture")) {
      applyAppearance(next.appearance);
    }
    setConfirmedDateTimePreferences({
      dateFormat: next.date_time.date_format,
      timeFormat: next.date_time.time_format,
    });
  }, []);

  const refreshSettingsStrict = useCallback(async () => {
    if (!hasStoredToken()) return;
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const next = await getSettings();
      applySettingsPayload(next);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Could not load settings");
      throw error;
    } finally {
      setSettingsLoading(false);
    }
  }, [applySettingsPayload]);

  const refreshSettings = useCallback(async () => {
    try {
      await refreshSettingsStrict();
    } catch {
      // Ordinary refreshes expose errors in state; event-reset handling uses strict refresh.
    }
  }, [refreshSettingsStrict]);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const registerTaskEventHandler = useCallback((handler: (event: CommittedEventDto) => void) => {
    taskEventHandlersRef.current.add(handler);
    return () => {
      taskEventHandlersRef.current.delete(handler);
    };
  }, []);

  const registerTaskResyncHandler = useCallback((handler: () => void | Promise<void>) => {
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

  const onTaskResync = useCallback(async () => {
    await Promise.all([...taskResyncHandlersRef.current].map((handler) => handler()));
  }, []);

  const onCatalogResync = useCallback(() => requestCatalogResync(), [requestCatalogResync]);

  const onSettingsEvent = useCallback(
    (event: CommittedEventDto) => {
      setRevision((prev) => Math.max(prev, event.revision));
      if (event.event_type === "settings.updated" || event.resync.settings) {
        void refreshSettings();
      }
    },
    [refreshSettings],
  );

  const onSettingsResync = useCallback(() => refreshSettingsStrict(), [refreshSettingsStrict]);

  const onReconnect = useCallback(() => {
    // On reconnect, SSE client sends Last-Event-ID for catch-up.
    // If catch-up fails, the server sends sync.resync_required which triggers onTaskResync/onCatalogResync.
    // Also force a catalog refresh as a safety net.
    requestCatalogResync();
    void refreshSettings();
  }, [requestCatalogResync, refreshSettings]);

  const onTerminalError = useCallback((message: string) => {
    // Ignore post-restore 503/terminal noise once cutover authoritatively confirmed restart.
    if (restartRequiredRef.current) return;
    setSseError(message);
  }, []);

  const enterRestartRequired = useCallback(() => {
    // Synchronous ref first so in-flight terminal callbacks cannot race setState.
    restartRequiredRef.current = true;
    setRestartRequired(true);
    setSseError(null);
  }, []);

  // SSE is enabled once we have a token; disabled after restore restart-required cutover.
  const sseEnabled = hasStoredToken() && !restartRequired;

  useSseSubscription(
    {
      onTaskEvent,
      onCatalogEvent,
      onSettingsEvent,
      onTaskResync,
      onCatalogResync,
      onSettingsResync,
      onReconnect,
      onTerminalError,
    },
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
      if (event.event_type === "settings.updated" || event.resync.settings) {
        void refreshSettings();
      }
    },
    [applyCatalogEventFn, requestCatalogResync, refreshSettings],
  );

  /** One coalesced task + catalog resync after ambiguous network failure. */
  const resyncAfterOutcomeUnknown = useCallback(() => {
    for (const handler of taskResyncHandlersRef.current) {
      handler();
    }
    requestCatalogResync();
  }, [requestCatalogResync]);

  const saveSettings = useCallback(
    async (patch: PatchSettingsRequest): Promise<MutationResponse> => {
      const operationId = generateOperationId();
      try {
        const result = await patchSettings(patch, operationId);
        applyOwnCommittedEvent(result.event);
        // Authoritative refresh so appearance applies only after confirmed persistence.
        await refreshSettings();
        return result;
      } catch (error) {
        if (isOutcomeUnknown(error)) {
          resyncAfterOutcomeUnknown();
          void refreshSettings();
          throw new NetworkError(
            error instanceof Error ? error.message : "Settings save outcome unknown",
            true,
          );
        }
        throw error;
      }
    },
    [applyOwnCommittedEvent, refreshSettings, resyncAfterOutcomeUnknown],
  );

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
      enterRestartRequired,
      registerTaskEventHandler,
      registerTaskResyncHandler,
      runMutation,
      settings,
      settingsLoading,
      settingsError,
      refreshSettings,
      saveSettings,
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
      enterRestartRequired,
      registerTaskEventHandler,
      registerTaskResyncHandler,
      runMutation,
      settings,
      settingsLoading,
      settingsError,
      refreshSettings,
      saveSettings,
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
