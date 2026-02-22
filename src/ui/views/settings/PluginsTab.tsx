import { useState, useMemo } from "react";
import { Puzzle, Search } from "lucide-react";
import { usePluginContext } from "../../context/PluginContext.js";
import { PermissionDialog } from "../../components/PermissionDialog.js";
import { api, type PluginInfo } from "../../api/index.js";
import { PluginCard } from "../../components/PluginCard.js";
import { PluginBrowser } from "../../components/PluginBrowser.js";

export function PluginsTab() {
  const {
    plugins,
    refreshPlugins,
    refreshViews,
    refreshPanels,
    refreshStatusBar,
    refreshCommands,
  } = usePluginContext();
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [permissionPlugin, setPermissionPlugin] = useState<PluginInfo | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [browserOpen, setBrowserOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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
          <h2 className="text-lg font-semibold mb-3 text-on-surface">Community Plugins</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

      <PluginBrowser open={browserOpen} onClose={() => setBrowserOpen(false)} />

      {permissionPlugin && (
        <PermissionDialog
          pluginName={permissionPlugin.name}
          permissions={permissionPlugin.permissions}
          onApprove={handleApprove}
          onCancel={() => setPermissionPlugin(null)}
        />
      )}
    </>
  );
}
