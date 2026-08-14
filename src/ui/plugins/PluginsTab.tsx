/**
 * Settings → Extensions tab (id: plugins).
 * Lazy-loaded operator surface for installed plugins, Restricted Mode, registry.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Puzzle, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import type { CommittedEventDto } from "../api/client";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useWorkspace } from "../context/WorkspaceContext";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { PluginCard } from "./components/PluginCard";
import { PermissionDialog } from "./components/PermissionDialog";
import { Toggle } from "./components/Toggle";
import { createPluginOperationId } from "./operation-id";
import * as transport from "./transport";
import { arePermissionsFullyGranted } from "./parsers";
import type {
  CommunityPolicy,
  InstalledPlugin,
  PluginPermission,
  PluginSetting,
  PluginSettingValue,
  SettingDeclaration,
} from "./types";

const PluginBrowser = lazy(() =>
  import("./components/PluginBrowser").then((m) => ({ default: m.PluginBrowser })),
);

export type PluginsTabProps = {
  /** Offline fixture overrides for visual scenes. */
  fixture?: {
    plugins?: InstalledPlugin[];
    communityEnabled?: boolean;
    loadMode?: "ready" | "loading" | "error";
    loadError?: string;
    expandedPluginId?: string | null;
    openSafetyDialog?: boolean;
    openPermissionPluginId?: string | null;
    openBrowser?: boolean;
    searchQuery?: string;
    settingDeclarations?: Record<string, SettingDeclaration[]>;
    settingValues?: Record<string, PluginSetting[]>;
    browserEntries?: import("./components/PluginBrowser").BrowserPlugin[];
    browserMode?: "ready" | "loading" | "error" | "empty";
    browserSelectedId?: string | null;
    browserFilterTab?: "all" | "installed" | "not-installed";
    browserSearchQuery?: string;
  };
};

function pluginActionError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type RegisterTaskEventHandler = (handler: (event: CommittedEventDto) => void) => () => void;

/**
 * Settings → Extensions entry. Fixture scenes stay offline and never touch WorkspaceContext
 * so visual harnesses and snapshot tests do not subscribe or refresh over transport.
 */
export function PluginsTab(props: PluginsTabProps = {}) {
  if (props.fixture) {
    return <PluginsTabBody {...props} registerTaskEventHandler={undefined} />;
  }
  return <PluginsTabConnected {...props} />;
}

function PluginsTabConnected(props: PluginsTabProps) {
  const { registerTaskEventHandler } = useWorkspace();
  return <PluginsTabBody {...props} registerTaskEventHandler={registerTaskEventHandler} />;
}

function PluginsTabBody({
  fixture,
  registerTaskEventHandler,
}: PluginsTabProps & {
  registerTaskEventHandler?: RegisterTaskEventHandler;
}) {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>(fixture?.plugins ?? []);
  const [policy, setPolicy] = useState<CommunityPolicy | null>(
    fixture
      ? {
          enabled: fixture.communityEnabled ?? false,
          updatedAt: "2026-08-04T15:00:00.000Z",
        }
      : null,
  );
  const [loadState, setLoadState] = useState<"ready" | "loading" | "error">(
    fixture?.loadMode ?? "loading",
  );
  const [loadError, setLoadError] = useState<string | null>(fixture?.loadError ?? null);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(
    fixture?.expandedPluginId ?? null,
  );
  const [permissionPlugin, setPermissionPlugin] = useState<InstalledPlugin | null>(() => {
    if (!fixture?.openPermissionPluginId) return null;
    return fixture.plugins?.find((p) => p.pluginId === fixture.openPermissionPluginId) ?? null;
  });
  const [approvalPending, setApprovalPending] = useState(false);
  const [pluginPendingUninstall, setPluginPendingUninstall] = useState<InstalledPlugin | null>(
    null,
  );
  const [uninstallPending, setUninstallPending] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [browserOpen, setBrowserOpen] = useState(Boolean(fixture?.openBrowser));
  const [searchQuery, setSearchQuery] = useState(fixture?.searchQuery ?? "");
  const [showSafetyDialog, setShowSafetyDialog] = useState(Boolean(fixture?.openSafetyDialog));
  const [actionError, setActionError] = useState<string | null>(null);
  const [settingValues, setSettingValues] = useState<Record<string, PluginSetting[]>>(
    fixture?.settingValues ?? {},
  );
  const safetyOverlayRef = useRef<HTMLDivElement>(null);
  const safetyDialogRef = useRef<HTMLDivElement>(null);
  const uninstallOverlayRef = useRef<HTMLDivElement>(null);
  const uninstallDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(safetyDialogRef, showSafetyDialog);
  useFocusTrap(uninstallDialogRef, pluginPendingUninstall !== null);

  const isRestricted = !(policy?.enabled ?? false);
  const isFixture = Boolean(fixture);
  // Keep refresh identity stable so event subscription does not churn on list length.
  const hasPluginsRef = useRef(plugins.length > 0);
  hasPluginsRef.current = plugins.length > 0;

  const refresh = useCallback(async () => {
    if (isFixture) return;
    setLoadState((prev) => (hasPluginsRef.current ? prev : "loading"));
    try {
      const [list, community] = await Promise.all([
        transport.listPlugins(),
        transport.getCommunityPolicy(),
      ]);
      setPlugins(list);
      setPolicy(community);
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      setLoadState("error");
      setLoadError(pluginActionError(error, "Extensions could not be loaded."));
    }
  }, [isFixture]);

  useEffect(() => {
    if (isFixture) {
      setLoadState(fixture?.loadMode ?? "ready");
      return;
    }
    void refresh();
  }, [isFixture, fixture?.loadMode, refresh]);

  // Server-confirmed plugin product events refresh installed/policy authority while mounted.
  useEffect(() => {
    if (isFixture || !registerTaskEventHandler) return;
    return registerTaskEventHandler((event) => {
      if (typeof event.event_type === "string" && event.event_type.startsWith("plugin.")) {
        void refresh();
      }
    });
  }, [isFixture, registerTaskEventHandler, refresh]);

  useEffect(() => {
    if (!showSafetyDialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSafetyDialog(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showSafetyDialog]);

  useEffect(() => {
    if (!pluginPendingUninstall) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !uninstallPending) {
        event.preventDefault();
        setPluginPendingUninstall(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pluginPendingUninstall, uninstallPending]);

  // Load settings when a card expands.
  useEffect(() => {
    if (isFixture || !expandedPlugin) return;
    let cancelled = false;
    void (async () => {
      try {
        const values = await transport.listPluginSettings(expandedPlugin);
        if (!cancelled) {
          setSettingValues((prev) => ({ ...prev, [expandedPlugin]: values }));
        }
      } catch {
        // Settings optional — card still expands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandedPlugin, isFixture]);

  const builtinPlugins = useMemo(() => {
    const builtin = plugins.filter((p) => p.builtin);
    if (!searchQuery.trim()) return builtin;
    const q = searchQuery.toLowerCase();
    return builtin.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [plugins, searchQuery]);

  const communityPlugins = useMemo(() => {
    const community = plugins.filter((p) => !p.builtin);
    if (!searchQuery.trim()) return community;
    const q = searchQuery.toLowerCase();
    return community.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [plugins, searchQuery]);

  const handleApprove = async (permissions: PluginPermission[]) => {
    if (!permissionPlugin || approvalPending) return;
    if (isFixture) {
      setPermissionPlugin(null);
      return;
    }
    const pluginId = permissionPlugin.pluginId;
    setApprovalPending(true);
    try {
      setActionError(null);
      await transport.replaceGrants(pluginId, permissionPlugin.packageGeneration, permissions, {
        operationId: createPluginOperationId(),
      });
      if (!permissionPlugin.desiredEnabled) {
        await transport.enablePlugin(pluginId, { operationId: createPluginOperationId() });
      }
      setPermissionPlugin(null);
      await refresh();
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to approve plugin permissions"));
    } finally {
      setApprovalPending(false);
    }
  };

  const handleRevoke = async (pluginId: string) => {
    if (isFixture) return;
    const plugin = plugins.find((p) => p.pluginId === pluginId);
    if (!plugin) return;
    try {
      setActionError(null);
      await transport.revokeGrants(pluginId, plugin.packageGeneration, {
        operationId: createPluginOperationId(),
      });
      await refresh();
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to revoke plugin permissions"));
    }
  };

  const handleToggle = async (pluginId: string) => {
    const plugin = plugins.find((p) => p.pluginId === pluginId);
    if (!plugin) return;
    if (
      !plugin.desiredEnabled &&
      !arePermissionsFullyGranted(plugin.requestedPermissions, plugin.grantedPermissions)
    ) {
      setPermissionPlugin(plugin);
      return;
    }
    if (isFixture) {
      setPlugins((prev) =>
        prev.map((p) =>
          p.pluginId === pluginId
            ? {
                ...p,
                desiredEnabled: !p.desiredEnabled,
                runtimeState: !p.desiredEnabled ? "active" : "disabled",
              }
            : p,
        ),
      );
      return;
    }
    setToggling((prev) => new Set(prev).add(pluginId));
    try {
      setActionError(null);
      if (plugin.desiredEnabled) {
        await transport.disablePlugin(pluginId, { operationId: createPluginOperationId() });
      } else {
        await transport.enablePlugin(pluginId, { operationId: createPluginOperationId() });
      }
      await refresh();
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to toggle plugin"));
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
  };

  const handleConfirmUninstall = async () => {
    if (!pluginPendingUninstall || uninstallPending || isFixture) return;
    const plugin = pluginPendingUninstall;
    setUninstallPending(true);
    try {
      setActionError(null);
      await transport.uninstallPlugin(plugin.pluginId, {
        operationId: createPluginOperationId(),
      });
      await refresh();
      setPluginPendingUninstall(null);
    } catch (error) {
      setActionError(pluginActionError(error, `Failed to uninstall ${plugin.name}`));
      setPluginPendingUninstall(null);
    } finally {
      setUninstallPending(false);
    }
  };

  const handleSettingChange = async (pluginId: string, key: string, value: PluginSettingValue) => {
    if (isFixture) {
      setSettingValues((prev) => {
        const list = prev[pluginId] ?? [];
        const next = list.filter((s) => s.key !== key);
        next.push({ key, value, updatedAt: new Date().toISOString() });
        return { ...prev, [pluginId]: next };
      });
      return;
    }
    const plugin = plugins.find((p) => p.pluginId === pluginId);
    if (!plugin) return;
    try {
      await transport.setPluginSetting(pluginId, key, plugin.packageGeneration, value, {
        operationId: createPluginOperationId(),
      });
      const values = await transport.listPluginSettings(pluginId);
      setSettingValues((prev) => ({ ...prev, [pluginId]: values }));
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to update setting"));
    }
  };

  const setCommunity = async (enabled: boolean) => {
    if (isFixture) {
      setPolicy({ enabled, updatedAt: new Date().toISOString() });
      setShowSafetyDialog(false);
      return;
    }
    try {
      setActionError(null);
      await transport.setCommunityPolicy(enabled, { operationId: createPluginOperationId() });
      const community = await transport.getCommunityPolicy();
      setPolicy(community);
      setShowSafetyDialog(false);
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to update plugin mode"));
    }
  };

  return (
    <>
      {isRestricted && (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-warning" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-on-surface">Restricted Mode is ON</h3>
              <p className="mt-1 text-xs text-on-surface-muted">
                Community plugins are disabled for security. Only built-in extensions can be
                enabled. Community plugins can execute arbitrary code — only enable this if you
                trust your plugin sources.
              </p>
              <button
                type="button"
                onClick={() => setShowSafetyDialog(true)}
                className="mt-2 rounded text-xs font-medium text-on-surface-secondary underline hover:text-on-surface"
              >
                Turn off Restricted Mode
              </button>
            </div>
          </div>
        </div>
      )}

      {loadState === "error" && (
        <div className="mb-4 rounded-lg border border-error/30 bg-error/5 p-3" role="alert">
          <p className="text-sm text-error">
            {plugins.length > 0
              ? "Plugin data could not be refreshed. Showing the last known extensions."
              : "Extensions could not be loaded."}
            {loadError ? ` ${loadError}` : ""}
          </p>
          <button
            type="button"
            className="mt-2 rounded border border-border px-2.5 py-1 text-xs font-medium text-on-surface-secondary hover:bg-surface-secondary"
            onClick={() => void refresh()}
          >
            Retry extensions
          </button>
        </div>
      )}

      {actionError && (
        <div className="mb-4 text-sm text-error" role="alert">
          <p>{actionError}</p>
        </div>
      )}

      {loadState === "loading" && plugins.length === 0 && (
        <p className="mb-4 text-sm text-on-surface-muted" role="status">
          Loading extensions...
        </p>
      )}

      <div className="relative mb-6 max-w-md">
        <Search
          size={16}
          className="absolute top-1/2 left-3 -translate-y-1/2 text-on-surface-muted"
        />
        <input
          type="search"
          aria-label="Search plugins"
          placeholder="Search plugins..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface py-2 pr-3 pl-9 text-sm text-on-surface placeholder-on-surface-muted focus:ring-2 focus:ring-focus focus:outline-none"
        />
      </div>

      {builtinPlugins.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-on-surface">Built-in Extensions</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {builtinPlugins.map((plugin) => (
              <PluginCard
                key={plugin.pluginId}
                plugin={plugin}
                expanded={expandedPlugin === plugin.pluginId}
                onToggleExpand={() =>
                  setExpandedPlugin(expandedPlugin === plugin.pluginId ? null : plugin.pluginId)
                }
                toggling={toggling.has(plugin.pluginId)}
                onToggle={() => void handleToggle(plugin.pluginId)}
                onRequestApproval={() => setPermissionPlugin(plugin)}
                settingDeclarations={
                  fixture?.settingDeclarations?.[plugin.pluginId] ?? plugin.settingDeclarations
                }
                settingValues={settingValues[plugin.pluginId]}
                onSettingChange={(key, value) =>
                  void handleSettingChange(plugin.pluginId, key, value)
                }
                onRetry={
                  isFixture
                    ? undefined
                    : () =>
                        void transport
                          .retryPlugin(plugin.pluginId, { operationId: createPluginOperationId() })
                          .then(refresh)
                }
              />
            ))}
          </div>
        </section>
      )}

      {(communityPlugins.length > 0 || !isRestricted) && (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-on-surface">Community Plugins</h3>
              <p className="text-xs text-on-surface-muted">
                Third-party extensions from the plugin registry
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-on-surface-muted">
                {isRestricted ? "Restricted" : "Enabled"}
              </span>
              <Toggle
                label="Community plugins"
                enabled={!isRestricted}
                onToggle={() => {
                  if (!isRestricted) void setCommunity(false);
                  else setShowSafetyDialog(true);
                }}
              />
            </div>
          </div>
          {communityPlugins.length > 0 ? (
            <div
              aria-disabled={isRestricted || undefined}
              className={`grid grid-cols-1 gap-4 md:grid-cols-2 ${isRestricted ? "opacity-50" : ""}`}
            >
              {communityPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.pluginId}
                  plugin={plugin}
                  expanded={expandedPlugin === plugin.pluginId}
                  onToggleExpand={() =>
                    setExpandedPlugin(expandedPlugin === plugin.pluginId ? null : plugin.pluginId)
                  }
                  onToggle={() => void handleToggle(plugin.pluginId)}
                  onRequestApproval={() => setPermissionPlugin(plugin)}
                  onRevoke={() => void handleRevoke(plugin.pluginId)}
                  isRestricted={isRestricted}
                  settingDeclarations={
                    fixture?.settingDeclarations?.[plugin.pluginId] ?? plugin.settingDeclarations
                  }
                  settingValues={settingValues[plugin.pluginId]}
                  onSettingChange={(key, value) =>
                    void handleSettingChange(plugin.pluginId, key, value)
                  }
                  onUninstall={isFixture ? undefined : () => setPluginPendingUninstall(plugin)}
                  onRetry={
                    isFixture
                      ? undefined
                      : () =>
                          void transport
                            .retryPlugin(plugin.pluginId, {
                              operationId: createPluginOperationId(),
                            })
                            .then(refresh)
                  }
                />
              ))}
            </div>
          ) : null}
        </section>
      )}

      {loadState === "ready" &&
        searchQuery.trim() &&
        builtinPlugins.length === 0 &&
        communityPlugins.length === 0 && (
          <p className="py-4 text-sm text-on-surface-muted">No plugins match your search.</p>
        )}

      {loadState === "ready" && !searchQuery.trim() && builtinPlugins.length === 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-on-surface">Built-in Extensions</h2>
          <p className="text-sm text-on-surface-muted">No built-in extensions available.</p>
        </section>
      )}

      <section className="mb-8">
        <div className="border-t border-border pt-6">
          <button
            type="button"
            onClick={() => setBrowserOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-action px-4 py-2.5 text-sm font-medium text-on-accent-action transition-colors hover:bg-accent-action-hover"
          >
            <Puzzle size={16} />
            Browse Community Plugins
          </button>
          <p className="mt-2 text-xs text-on-surface-muted">
            Discover and install extensions from the community.
          </p>
        </div>
      </section>

      {browserOpen && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <PluginBrowser
              open={browserOpen}
              onClose={() => setBrowserOpen(false)}
              installedPlugins={plugins}
              onInstalledChange={refresh}
              onReviewPermissions={setPermissionPlugin}
              fixtureEntries={fixture?.browserEntries}
              fixtureMode={fixture?.browserMode}
              initialSearch={fixture?.browserSearchQuery}
              initialFilter={fixture?.browserFilterTab}
              initialSelectedId={fixture?.browserSelectedId ?? null}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {permissionPlugin && (
        <PermissionDialog
          pluginName={permissionPlugin.name}
          permissions={permissionPlugin.requestedPermissions}
          publisherKeyId={permissionPlugin.publisherKeyId}
          onApprove={(permissions) => void handleApprove(permissions)}
          onCancel={() => setPermissionPlugin(null)}
          pending={approvalPending}
        />
      )}

      {pluginPendingUninstall && (
        <div
          ref={uninstallOverlayRef}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          onClick={(event) => {
            if (event.target === uninstallOverlayRef.current && !uninstallPending) {
              setPluginPendingUninstall(null);
            }
          }}
        >
          <div
            ref={uninstallDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-uninstall-title"
            aria-describedby="plugin-uninstall-description"
            className="mx-4 w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
          >
            <h3 id="plugin-uninstall-title" className="text-base font-semibold text-on-surface">
              Uninstall {pluginPendingUninstall.name}?
            </h3>
            <p id="plugin-uninstall-description" className="mt-2 text-sm text-on-surface-muted">
              This removes the extension and its local plugin data. This action cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-autofocus
                disabled={uninstallPending}
                onClick={() => setPluginPendingUninstall(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary focus:ring-2 focus:ring-focus focus:outline-none disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={uninstallPending}
                onClick={() => void handleConfirmUninstall()}
                className="inline-flex items-center gap-2 rounded-lg bg-error px-4 py-2 text-sm font-medium text-white hover:bg-error/90 focus:ring-2 focus:ring-focus focus:outline-none disabled:opacity-50"
              >
                {uninstallPending ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    Uninstalling...
                  </>
                ) : (
                  "Uninstall"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSafetyDialog && (
        <div
          ref={safetyOverlayRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(event) => {
            if (event.target === safetyOverlayRef.current) setShowSafetyDialog(false);
          }}
        >
          <div
            ref={safetyDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="community-plugin-safety-title"
            className="mx-4 w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="mb-3 flex items-center gap-3">
              <ShieldAlert size={24} className="text-warning" />
              <h3
                id="community-plugin-safety-title"
                className="text-base font-semibold text-on-surface"
              >
                Enable community plugins?
              </h3>
            </div>
            <p className="mb-4 text-sm text-on-surface-muted">
              Community plugins are created by third-party developers and can run arbitrary code on
              your machine. Only enable plugins from sources you trust.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-autofocus
                onClick={() => setShowSafetyDialog(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary focus:ring-2 focus:ring-focus focus:outline-none"
              >
                Keep Restricted
              </button>
              <button
                type="button"
                onClick={() => void setCommunity(true)}
                className="rounded-lg bg-warning px-4 py-2 text-sm font-medium text-on-warning hover:bg-warning/90 focus:ring-2 focus:ring-focus focus:outline-none"
              >
                I understand, enable
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default PluginsTab;
