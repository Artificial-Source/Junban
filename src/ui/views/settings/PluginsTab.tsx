import { useState } from "react";
import { Puzzle } from "lucide-react";
import { usePluginContext } from "../../context/PluginContext.js";
import { PermissionDialog } from "../../components/PermissionDialog.js";
import { api, type PluginInfo } from "../../api/index.js";
import { PluginCard } from "../../components/PluginCard.js";
import { PluginBrowser } from "../../components/PluginBrowser.js";

export function PluginsTab() {
  const { plugins, refreshPlugins } = usePluginContext();
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [permissionPlugin, setPermissionPlugin] = useState<PluginInfo | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [browserOpen, setBrowserOpen] = useState(false);

  const builtinPlugins = plugins.filter((p) => p.builtin);
  const communityPlugins = plugins.filter((p) => !p.builtin);

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
      await refreshPlugins();
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
      {/* Built-in Extensions */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3 text-on-surface">Built-in Extensions</h2>
        {builtinPlugins.length === 0 ? (
          <p className="text-on-surface-muted text-sm">No built-in extensions available.</p>
        ) : (
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
        )}
      </section>

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
