/**
 * Host-rendered contribution slots: views, panels, status, command helpers.
 */

import { useEffect, useMemo, useState } from "react";
import { Puzzle } from "lucide-react";
import { DeclarativeRenderer } from "./DeclarativeRenderer";
import { partitionContributions, usePlugins } from "./PluginProvider";
import type { PluginContribution, RenderedContribution } from "./types";

export function pluginCommandPaletteEntries(
  contributions: PluginContribution[],
  invoke: (contribution: PluginContribution) => Promise<void>,
): Array<{ id: string; name: string; callback: () => void | Promise<void> }> {
  const { commands } = partitionContributions(contributions);
  return commands.map((contribution) => ({
    id: `plugin:${contribution.pluginId}:${contribution.localId}`,
    name: `${contribution.title} — ${contribution.pluginId}`,
    callback: () => invoke(contribution),
  }));
}

export function PluginStatusBar({ className = "" }: { className?: string }) {
  const { contributions, renderSurface, invokeAction } = usePlugins();
  // Memoize so the render effect does not thrash on a fresh partition array each paint.
  const statuses = useMemo(() => partitionContributions(contributions).statuses, [contributions]);
  const [rendered, setRendered] = useState<Record<string, RenderedContribution | null>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, RenderedContribution | null> = {};
      for (const status of statuses) {
        next[status.contributionId] = await renderSurface(status);
      }
      if (!cancelled) setRendered(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [statuses, renderSurface]);

  if (statuses.length === 0) return null;

  return (
    <div
      data-testid="plugin-status-bar"
      className={`flex items-center gap-3 border-t border-border bg-surface-secondary/60 px-3 py-1.5 text-xs text-on-surface-secondary ${className}`}
    >
      {statuses.map((status) => {
        const surface = rendered[status.contributionId];
        if (!surface) {
          return (
            <span key={status.contributionId} className="inline-flex items-center gap-1">
              <Puzzle size={12} aria-hidden="true" />
              {status.title}
            </span>
          );
        }
        return (
          <DeclarativeRenderer
            key={status.contributionId}
            surface={surface.surface}
            className="inline-flex items-center gap-2"
            onAction={(actionId, values) => void invokeAction(status, actionId, values)}
          />
        );
      })}
    </div>
  );
}

export type PluginSidebarPanelsProps = {
  /** Collapsed chrome hides panel bodies entirely (no partial icon-only state). */
  collapsed?: boolean;
};

export function PluginSidebarPanels({ collapsed = false }: PluginSidebarPanelsProps) {
  const { contributions, renderSurface, invokeAction } = usePlugins();
  // Memoize so the render effect does not thrash on a fresh partition array each paint.
  const sidebarPanels = useMemo(
    () => partitionContributions(contributions).sidebarPanels,
    [contributions],
  );
  const [rendered, setRendered] = useState<Record<string, RenderedContribution | null>>({});

  useEffect(() => {
    if (collapsed) {
      setRendered({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, RenderedContribution | null> = {};
      for (const panel of sidebarPanels) {
        next[panel.contributionId] = await renderSurface(panel);
      }
      if (!cancelled) setRendered(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [collapsed, sidebarPanels, renderSurface]);

  // Conservative collapsed behavior: do not reserve sidebar chrome for panel content.
  if (collapsed || sidebarPanels.length === 0) return null;

  return (
    <div data-testid="plugin-sidebar-panels" className="space-y-3 p-3">
      {sidebarPanels.map((panel) => (
        <PluginPanel
          key={panel.contributionId}
          title={panel.title}
          contribution={panel}
          rendered={rendered[panel.contributionId] ?? null}
          onAction={(actionId, values) => void invokeAction(panel, actionId, values)}
        />
      ))}
    </div>
  );
}

export function PluginPanel({
  title,
  contribution,
  rendered,
  onAction,
  children,
}: {
  title: string;
  contribution?: PluginContribution;
  rendered?: RenderedContribution | null;
  onAction?: (actionId: string, values: import("./types").ScalarNamedValue[]) => void;
  children?: React.ReactNode;
}) {
  return (
    <section
      data-testid="plugin-panel"
      data-plugin-id={contribution?.pluginId}
      className="rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold text-on-surface">{title}</h3>
      </header>
      <div className="p-3">
        {children}
        {rendered ? (
          <DeclarativeRenderer surface={rendered.surface} onAction={onAction} />
        ) : !children ? (
          <p className="text-xs text-on-surface-muted">Loading…</p>
        ) : null}
      </div>
    </section>
  );
}

export function PluginViewHost({ contribution }: { contribution: PluginContribution }) {
  const { renderSurface, invokeAction } = usePlugins();
  const [rendered, setRendered] = useState<RenderedContribution | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setError(null);
      const result = await renderSurface(contribution);
      if (cancelled) return;
      if (!result) {
        setError("This plugin view is unavailable. It may have been disabled or revoked.");
        setRendered(null);
        return;
      }
      setRendered(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [contribution, renderSurface]);

  return (
    <div data-testid="plugin-view-host" className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold text-on-surface">{contribution.title}</h1>
        <p className="text-xs text-on-surface-muted">Plugin view · {contribution.pluginId}</p>
      </header>
      <div className="flex flex-1 items-center justify-center overflow-auto p-8">
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : rendered ? (
          <DeclarativeRenderer
            surface={rendered.surface}
            onAction={(actionId, values) => void invokeAction(contribution, actionId, values)}
          />
        ) : (
          <p role="status" className="text-sm text-on-surface-muted">
            Loading plugin view…
          </p>
        )}
      </div>
    </div>
  );
}

/** Navigation entries for sidebar tools/nav slots (namespaced ids). */
export function pluginNavItems(contributions: PluginContribution[]) {
  const { navViews } = partitionContributions(contributions);
  return navViews.map((c) => ({
    id: `plugin-view:${c.pluginId}:${c.localId}`,
    pluginId: c.pluginId,
    surfaceId: c.localId,
    label: c.title,
    location: c.location ?? "tools",
    contribution: c,
  }));
}
