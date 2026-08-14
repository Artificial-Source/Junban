/**
 * App-level plugin contribution state.
 * Loads server-confirmed contributions; drops them on stale/revoke/health events.
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
import { isStaleAuthorityError } from "./parsers";
import { createPluginOperationId } from "./operation-id";
import * as transport from "./transport";
import type { PluginContribution, RenderedContribution } from "./types";
import { fenceOf } from "./DeclarativeRenderer";

export type PluginContextValue = {
  contributions: PluginContribution[];
  loading: boolean;
  error: string | null;
  refreshContributions: () => Promise<void>;
  /** Drop all contributions and re-fetch (stale fence / health / uninstall). */
  invalidateContributions: () => Promise<void>;
  invokeCommand: (contribution: PluginContribution) => Promise<void>;
  renderSurface: (contribution: PluginContribution) => Promise<RenderedContribution | null>;
  invokeAction: (
    contribution: PluginContribution,
    actionId: string,
    values?: Parameters<typeof transport.invokeSurfaceAction>[4],
  ) => Promise<void>;
  handlePluginEvent: (eventType: string) => void;
};

const PluginContext = createContext<PluginContextValue | null>(null);

const EMPTY_PLUGIN_CONTEXT: PluginContextValue = Object.freeze({
  contributions: Object.freeze([]) as unknown as PluginContribution[],
  loading: false,
  error: null,
  refreshContributions: async () => undefined,
  invalidateContributions: async () => undefined,
  invokeCommand: async () => undefined,
  renderSurface: async () => null,
  invokeAction: async () => undefined,
  handlePluginEvent: () => undefined,
});

export function PluginProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const [contributions, setContributions] = useState<PluginContribution[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const refreshContributions = useCallback(async () => {
    if (!enabled) {
      setContributions([]);
      return;
    }
    const gen = ++generationRef.current;
    setLoading(true);
    try {
      const list = await transport.listContributions();
      if (gen !== generationRef.current) return;
      setContributions(list);
      setError(null);
    } catch (err) {
      if (gen !== generationRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load plugin contributions");
      // Keep last known set unless authority is stale.
      if (isStaleAuthorityError(err)) {
        setContributions([]);
      }
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  }, [enabled]);

  const invalidateContributions = useCallback(async () => {
    setContributions([]);
    await refreshContributions();
  }, [refreshContributions]);

  useEffect(() => {
    void refreshContributions();
  }, [refreshContributions]);

  const invokeCommand = useCallback(
    async (contribution: PluginContribution) => {
      if (contribution.kind !== "command") {
        throw new Error("plugin contribution is not a command");
      }
      try {
        await transport.invokeCommand(
          contribution.pluginId,
          contribution.localId,
          fenceOf(contribution),
          [],
          { operationId: createPluginOperationId() },
        );
      } catch (err) {
        if (isStaleAuthorityError(err)) {
          await invalidateContributions();
        }
        throw err;
      }
    },
    [invalidateContributions],
  );

  const renderSurface = useCallback(
    async (contribution: PluginContribution): Promise<RenderedContribution | null> => {
      try {
        return await transport.renderSurface(
          contribution.pluginId,
          contribution.localId,
          fenceOf(contribution),
        );
      } catch (err) {
        if (isStaleAuthorityError(err)) {
          await invalidateContributions();
        }
        return null;
      }
    },
    [invalidateContributions],
  );

  const invokeAction = useCallback(
    async (
      contribution: PluginContribution,
      actionId: string,
      values: Parameters<typeof transport.invokeSurfaceAction>[4] = [],
    ) => {
      try {
        await transport.invokeSurfaceAction(
          contribution.pluginId,
          contribution.localId,
          actionId,
          fenceOf(contribution),
          values,
          { operationId: createPluginOperationId() },
        );
      } catch (err) {
        if (isStaleAuthorityError(err)) {
          await invalidateContributions();
        }
        throw err;
      }
    },
    [invalidateContributions],
  );

  const handlePluginEvent = useCallback(
    (eventType: string) => {
      if (!eventType.startsWith("plugin.")) return;
      // Any plugin product event invalidates contribution authority.
      void invalidateContributions();
    },
    [invalidateContributions],
  );

  const value = useMemo<PluginContextValue>(
    () => ({
      contributions,
      loading,
      error,
      refreshContributions,
      invalidateContributions,
      invokeCommand,
      renderSurface,
      invokeAction,
      handlePluginEvent,
    }),
    [
      contributions,
      loading,
      error,
      refreshContributions,
      invalidateContributions,
      invokeCommand,
      renderSurface,
      invokeAction,
      handlePluginEvent,
    ],
  );

  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}

export function usePlugins(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) {
    // Safe no-op fallback when provider is absent (tests / early shell).
    return EMPTY_PLUGIN_CONTEXT;
  }
  return ctx;
}

/** Partition contributions by kind/location for chrome slots. */
export function partitionContributions(contributions: PluginContribution[]) {
  const commands = contributions.filter((c) => c.kind === "command");
  const views = contributions.filter((c) => c.kind === "view");
  const panels = contributions.filter((c) => c.kind === "panel");
  const statuses = contributions.filter((c) => c.kind === "status");
  const navViews = views.filter(
    (c) => c.location === "navigation" || c.location === "tools" || c.location === "workspace",
  );
  const sidebarPanels = panels.filter(
    (c) => !c.location || c.location === "sidebar" || c.location === "workspace",
  );
  return { commands, views, panels, statuses, navViews, sidebarPanels };
}
