import { lazy, Suspense, useState, useMemo } from "react";
import { Puzzle, Search, ShieldCheck, ShieldAlert } from "lucide-react";
import { usePluginContext } from "../../context/PluginContext.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";
import { api, type PluginInfo } from "../../api/index.js";
import { PluginCard } from "../../components/PluginCard.js";
import { ErrorBoundary } from "../../components/ErrorBoundary.js";
import { Toggle } from "./components.js";

const PluginBrowser = lazy(() =>
  import("../../components/PluginBrowser.js").then((module) => ({ default: module.PluginBrowser })),
);
const PermissionDialog = lazy(() =>
  import("../../components/PermissionDialog.js").then((module) => ({
    default: module.PermissionDialog,
  })),
);

export function PluginsTab() {
  const {
    plugins,
    refreshPlugins,
    refreshViews,
    refreshPanels,
    refreshStatusBar,
    refreshCommands,
  } = usePluginContext();
  const { settings, updateSetting } = useGeneralSettings();
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [permissionPlugin, setPermissionPlugin] = useState<PluginInfo | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [browserOpen, setBrowserOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSafetyDialog, setShowSafetyDialog] = useState(false);

  const isRestricted = settings.community_plugins_enabled !== "true";

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

  const handleApprove = async (permissions: string[]) => {
    if (permissionPlugin) {
      await api.approvePluginPermissions(permissionPlugin.id, permissions);
      setPermissionPlugin(null);
      refreshPlugins();
    }
  };

  const handleRevoke = async (pluginId: string) => {
    await api.revokePluginPermissions(pluginId);
    refreshPlugins();
  };

  const handleToggleBuiltin = async (pluginId: string) => {
    const plugin = plugins.find((p) => p.id === pluginId);
    // Show permission dialog when enabling a built-in plugin that has permissions and isn't already enabled
    if (plugin && !plugin.enabled && plugin.permissions.length > 0) {
      setPermissionPlugin(plugin);
      return;
    }
    setToggling((prev) => new Set(prev).add(pluginId));
    try {
      await api.togglePlugin(pluginId);
      await Promise.all([
        refreshPlugins(),
        refreshViews(),
        refreshPanels(),
        refreshStatusBar(),
        refreshCommands(),
      ]);
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
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
                className="mt-2 text-xs font-medium text-accent hover:underline"
              >
                Turn off Restricted Mode
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-md mb-6">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted"
        />
        <input
          type="text"
          placeholder="Search plugins..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
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
                enabled={settings.community_plugins_enabled === "true"}
                onToggle={() => {
                  if (settings.community_plugins_enabled === "true") {
                    updateSetting("community_plugins_enabled", "false");
                  } else {
                    setShowSafetyDialog(true);
                  }
                }}
              />
            </div>
          </div>
          <div
            className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${isRestricted ? "opacity-50 pointer-events-none" : ""}`}
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
              />
            ))}
          </div>
        </section>
      )}

      {/* Empty search state */}
      {searchQuery.trim() && builtinPlugins.length === 0 && communityPlugins.length === 0 && (
        <p className="text-sm text-on-surface-muted py-4">No plugins match your search.</p>
      )}

      {/* No plugins at all (without search) */}
      {!searchQuery.trim() && plugins.filter((p) => p.builtin).length === 0 && (
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
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors text-sm font-medium"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface rounded-xl shadow-2xl max-w-sm w-full mx-4 border border-border p-5">
            <div className="flex items-center gap-3 mb-3">
              <ShieldAlert size={24} className="text-warning" />
              <h3 className="text-base font-semibold text-on-surface">Enable community plugins?</h3>
            </div>
            <p className="text-sm text-on-surface-muted mb-4">
              Community plugins are created by third-party developers and can run arbitrary code on
              your machine. Only enable plugins from sources you trust.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSafetyDialog(false)}
                className="px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary rounded-lg"
              >
                Keep Restricted
              </button>
              <button
                onClick={() => {
                  updateSetting("community_plugins_enabled", "true");
                  setShowSafetyDialog(false);
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-warning hover:bg-warning/90 rounded-lg"
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
