import { lazy, Suspense, useState, useMemo, useEffect, useRef } from "react";
import { Puzzle, Search, ShieldCheck, ShieldAlert } from "lucide-react";
import { usePluginContext } from "../../context/PluginContext.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";
import { api, type PluginInfo } from "../../api/index.js";
import { PluginCard } from "../../components/PluginCard.js";
import { ErrorBoundary } from "../../components/ErrorBoundary.js";
import { Toggle } from "./components.js";
import { measureAsync } from "../../../utils/perf.js";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import { sanitizeUrlsInTextForLogging } from "../../../utils/url-sanitizer.js";
// Phase 7 harness-only fixture seed (overlaid next to this module in the temp worktree).
import { readFixture } from "./read-fixture.js";

const PluginBrowser = lazy(() =>
  import("../../components/PluginBrowser.js").then((module) => ({ default: module.PluginBrowser })),
);
const PermissionDialog = lazy(() =>
  import("../../components/PermissionDialog.js").then((module) => ({
    default: module.PermissionDialog,
  })),
);

function pluginActionError(error: unknown, fallback: string): string {
  return sanitizeUrlsInTextForLogging(error instanceof Error ? error.message : fallback);
}

export function PluginsTab() {
  const {
    plugins,
    resourceStates,
    reconciliationState,
    refreshPlugins,
    reconcileAppliedMutation,
    retryPluginReconciliation,
  } = usePluginContext();
  const { settings, refreshSettings } = useGeneralSettings();
  // Seed dialog/expand state from the offline Phase 7 fixture (capture-only overlay).
  const fixture = readFixture();
  const seededPermission =
    fixture.openPermissionPluginId != null
      ? (plugins.find((plugin) => plugin.id === fixture.openPermissionPluginId) ?? null)
      : null;
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(fixture.expandedPluginId);
  const [permissionPlugin, setPermissionPlugin] = useState<PluginInfo | null>(seededPermission);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [browserOpen, setBrowserOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState(fixture.searchQuery ?? "");
  const [showSafetyDialog, setShowSafetyDialog] = useState(Boolean(fixture.openSafetyDialog));
  const [actionError, setActionError] = useState<string | null>(null);
  const safetyOverlayRef = useRef<HTMLDivElement>(null);
  const safetyDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(safetyDialogRef, showSafetyDialog);

  const isRestricted = settings.community_plugins_enabled !== "true";
  const pluginLoadState = resourceStates.plugins;

  const builtinPlugins = useMemo(() => {
    const builtin = plugins.filter((p) => p.builtin);
    if (!searchQuery.trim()) return builtin;
    const q = searchQuery.toLowerCase();
    return builtin.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [plugins, searchQuery]);

  useEffect(() => {
    if (!showSafetyDialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSafetyDialog(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showSafetyDialog]);

  const communityPlugins = useMemo(() => {
    const community = plugins.filter((p) => !p.builtin);
    if (!searchQuery.trim()) return community;
    const q = searchQuery.toLowerCase();
    return community.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [plugins, searchQuery]);

  const handleApprove = async (permissions: string[]) => {
    if (!permissionPlugin || reconciliationState) return;
    const pluginId = permissionPlugin.id;
    try {
      setActionError(null);
      await measureAsync(
        "junban:plugin-enable",
        () => api.approvePluginPermissions(pluginId, permissions),
        { pluginId, mode: "approve" },
      );
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to approve plugin permissions"));
      return;
    }

    // Approval is already applied. Close the mutation dialog before any read
    // reconciliation so stale UI can never submit the approval again.
    setPermissionPlugin(null);
    await reconcileAppliedMutation("Plugin permission approval applied");
  };

  const handleRevoke = async (pluginId: string) => {
    if (reconciliationState) return;
    try {
      setActionError(null);
      await measureAsync("junban:plugin-disable", () => api.revokePluginPermissions(pluginId), {
        pluginId,
      });
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to revoke plugin permissions"));
      return;
    }
    await reconcileAppliedMutation("Plugin permission revocation applied");
  };

  const handleToggleBuiltin = async (pluginId: string) => {
    if (reconciliationState) return;
    const plugin = plugins.find((p) => p.id === pluginId);
    if (!plugin) return;
    // Show permission dialog when enabling a built-in plugin that has permissions and isn't already enabled
    if (!plugin.enabled && plugin.permissions.length > 0) {
      setPermissionPlugin(plugin);
      return;
    }
    setToggling((prev) => new Set(prev).add(pluginId));
    let applied = false;
    try {
      setActionError(null);
      await measureAsync(
        plugin.enabled ? "junban:plugin-disable" : "junban:plugin-enable",
        () => api.togglePlugin(pluginId),
        { pluginId },
      );
      applied = true;
    } catch (error) {
      setActionError(pluginActionError(error, "Failed to toggle plugin"));
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
    if (applied) await reconcileAppliedMutation("Plugin state change applied");
  };

  return (
    <>
      {/* Restricted Mode Banner */}
      {isRestricted && (
        <div className="mb-4 p-4 rounded-lg border border-warning/30 bg-warning/5">
          <div className="flex items-start gap-3">
            <ShieldCheck size={20} className="text-warning mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-on-surface">Restricted Mode is ON</h3>
              <p className="text-xs text-on-surface-muted mt-1">
                Community plugins are disabled for security. Only built-in extensions can be
                enabled. Community plugins can execute arbitrary code — only enable this if you
                trust your plugin sources.
              </p>
              <button
                onClick={() => setShowSafetyDialog(true)}
                disabled={reconciliationState !== null}
                className="mt-2 rounded text-xs font-medium text-on-surface-secondary underline hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
              >
                Turn off Restricted Mode
              </button>
            </div>
          </div>
        </div>
      )}

      {pluginLoadState.status === "error" && !reconciliationState && (
        <div className="mb-4 rounded-lg border border-error/30 bg-error/5 p-3" role="alert">
          <p className="text-sm text-error">
            {pluginLoadState.hasData
              ? "Plugin data could not be refreshed. Showing the last known extensions."
              : "Extensions could not be loaded."}
            {pluginLoadState.error ? ` ${pluginLoadState.error}` : ""}
          </p>
          <button
            type="button"
            className="mt-2 rounded border border-border px-2.5 py-1 text-xs font-medium text-on-surface-secondary hover:bg-surface-secondary"
            onClick={() => void refreshPlugins().catch(() => undefined)}
          >
            Retry extensions
          </button>
        </div>
      )}

      {reconciliationState?.error && (
        <div className="mb-4 text-sm text-error" role="alert">
          <p>
            {reconciliationState.message}; refresh pending. Showing the last known plugin data.{" "}
            {reconciliationState.error}
          </p>
          <button
            type="button"
            className="mt-2 rounded border border-current px-2.5 py-1 text-xs font-medium hover:bg-error/10"
            onClick={() => void retryPluginReconciliation()}
          >
            Retry refresh
          </button>
        </div>
      )}

      {actionError && (
        <div className="mb-4 text-sm text-error" role="alert">
          <p>{actionError}</p>
        </div>
      )}

      {!pluginLoadState.hasData && pluginLoadState.status === "loading" && (
        <p className="mb-4 text-sm text-on-surface-muted" role="status">
          Loading extensions...
        </p>
      )}

      {/* Search */}
      <div className="relative max-w-md mb-6">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted"
        />
        <input
          type="search"
          aria-label="Search plugins"
          placeholder="Search plugins..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
        />
      </div>

      {/* Built-in Extensions */}
      {builtinPlugins.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3 text-on-surface">Built-in Extensions</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {builtinPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                mode="settings"
                plugin={plugin}
                expanded={expandedPlugin === plugin.id}
                onToggleExpand={() =>
                  setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)
                }
                toggling={toggling.has(plugin.id)}
                onToggle={() => handleToggleBuiltin(plugin.id)}
                mutationDisabled={reconciliationState !== null}
              />
            ))}
          </div>
        </section>
      )}

      {/* Community Plugins */}
      {communityPlugins.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-medium text-on-surface">Community Plugins</h3>
              <p className="text-xs text-on-surface-muted">
                Third-party extensions from the plugin registry
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-on-surface-muted">
                {settings.community_plugins_enabled === "true" ? "Enabled" : "Restricted"}
              </span>
              <Toggle
                label="Community plugins"
                enabled={settings.community_plugins_enabled === "true"}
                disabled={reconciliationState !== null}
                onToggle={() => {
                  if (settings.community_plugins_enabled === "true") {
                    api
                      .setCommunityPluginsEnabled(false)
                      .then(() => refreshSettings())
                      .catch((err) => {
                        setActionError(pluginActionError(err, "Failed to update plugin mode"));
                      });
                  } else {
                    setShowSafetyDialog(true);
                  }
                }}
              />
            </div>
          </div>
          <div
            aria-disabled={isRestricted || undefined}
            className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${isRestricted ? "opacity-50" : ""}`}
          >
            {communityPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                mode="settings"
                plugin={plugin}
                expanded={expandedPlugin === plugin.id}
                onToggleExpand={() =>
                  setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)
                }
                onRequestApproval={() => setPermissionPlugin(plugin)}
                onRevoke={() => handleRevoke(plugin.id)}
                isRestricted={isRestricted}
                mutationDisabled={reconciliationState !== null}
              />
            ))}
          </div>
        </section>
      )}

      {/* Empty search state */}
      {pluginLoadState.hasData &&
        searchQuery.trim() &&
        builtinPlugins.length === 0 &&
        communityPlugins.length === 0 && (
          <p className="text-sm text-on-surface-muted py-4">No plugins match your search.</p>
        )}

      {/* No plugins at all (without search) */}
      {pluginLoadState.hasData &&
        !searchQuery.trim() &&
        plugins.filter((p) => p.builtin).length === 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-3 text-on-surface">Built-in Extensions</h2>
            <p className="text-on-surface-muted text-sm">No built-in extensions available.</p>
          </section>
        )}

      {/* Browse Community Plugins */}
      <section className="mb-8">
        <div className="border-t border-border pt-6">
          <button
            onClick={() => setBrowserOpen(true)}
            disabled={reconciliationState !== null}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent-action text-on-accent-action hover:bg-accent-action-hover transition-colors text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Puzzle size={16} />
            Browse Community Plugins
          </button>
          <p className="text-xs text-on-surface-muted mt-2">
            Discover and install extensions from the community.
          </p>
        </div>
      </section>

      {browserOpen && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <PluginBrowser open={browserOpen} onClose={() => setBrowserOpen(false)} />
          </Suspense>
        </ErrorBoundary>
      )}

      {permissionPlugin && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <PermissionDialog
              pluginName={permissionPlugin.name}
              permissions={permissionPlugin.permissions}
              onApprove={handleApprove}
              onCancel={() => setPermissionPlugin(null)}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Safety Confirmation Dialog */}
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
            className="bg-surface rounded-xl shadow-2xl max-w-sm w-full mx-4 border border-border p-5"
          >
            <div className="flex items-center gap-3 mb-3">
              <ShieldAlert size={24} className="text-warning" />
              <h3
                id="community-plugin-safety-title"
                className="text-base font-semibold text-on-surface"
              >
                Enable community plugins?
              </h3>
            </div>
            <p className="text-sm text-on-surface-muted mb-4">
              Community plugins are created by third-party developers and can run arbitrary code on
              your machine. Only enable plugins from sources you trust.
            </p>
            <div className="flex justify-end gap-2">
              <button
                data-autofocus="true"
                onClick={() => setShowSafetyDialog(false)}
                className="px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary rounded-lg focus:outline-none focus:ring-2 focus:ring-focus"
              >
                Keep Restricted
              </button>
              <button
                disabled={reconciliationState !== null}
                onClick={() => {
                  api
                    .setCommunityPluginsEnabled(true)
                    .then(() => refreshSettings())
                    .catch((err) => {
                      setActionError(pluginActionError(err, "Failed to update plugin mode"));
                    });
                  setShowSafetyDialog(false);
                }}
                className="px-4 py-2 text-sm font-medium text-on-warning bg-warning hover:bg-warning/90 rounded-lg focus:outline-none focus:ring-2 focus:ring-focus"
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
