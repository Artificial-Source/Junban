import { useState, useEffect, useMemo } from "react";
import { api, type StorePluginInfo } from "../api.js";
import { usePluginContext } from "../context/PluginContext.js";

export function PluginStore() {
  const [storePlugins, setStorePlugins] = useState<StorePluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [uninstalling, setUninstalling] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const { plugins: installedPlugins, refreshPlugins } = usePluginContext();

  useEffect(() => {
    const fetchStore = async () => {
      try {
        const data = await api.getPluginStore();
        setStorePlugins(data.plugins ?? []);
      } catch {
        // Non-critical
      }
      setLoading(false);
    };
    fetchStore();
  }, []);

  const installedIds = new Set(installedPlugins.map((p) => p.id));

  const filteredPlugins = useMemo(() => {
    if (!searchQuery.trim()) return storePlugins;
    const q = searchQuery.toLowerCase();
    return storePlugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [storePlugins, searchQuery]);

  const handleInstall = async (plugin: StorePluginInfo) => {
    if (!plugin.downloadUrl) {
      setError(`No download URL available for ${plugin.name}`);
      return;
    }

    setError(null);
    setInstalling((prev) => new Set(prev).add(plugin.id));

    try {
      await api.installPlugin(plugin.id, plugin.downloadUrl);
      await refreshPlugins();
    } catch (err) {
      setError(
        `Failed to install ${plugin.name}: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(plugin.id);
        return next;
      });
    }
  };

  const handleUninstall = async (pluginId: string) => {
    setError(null);
    setUninstalling((prev) => new Set(prev).add(pluginId));

    try {
      await api.uninstallPlugin(pluginId);
      await refreshPlugins();
    } catch (err) {
      setError(`Failed to uninstall: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setUninstalling((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Plugin Store</h1>
      <p className="text-gray-500 mb-4 text-sm">Browse community plugins for Docket.</p>

      <div className="mb-6">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search plugins..."
          className="w-full max-w-md px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-gray-400">Loading plugins...</p>
      ) : filteredPlugins.length === 0 ? (
        <p className="text-gray-400">
          {searchQuery ? "No plugins match your search." : "No plugins available."}
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredPlugins.map((plugin) => {
            const isInstalled = installedIds.has(plugin.id);
            const isInstalling = installing.has(plugin.id);
            const isUninstalling = uninstalling.has(plugin.id);

            return (
              <div
                key={plugin.id}
                className="border border-gray-200 dark:border-gray-700 rounded-lg p-4"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="font-medium text-sm">{plugin.name}</h3>
                    <p className="text-xs text-gray-400">
                      by {plugin.author} — v{plugin.version}
                    </p>
                  </div>
                  <div>
                    {isInstalled ? (
                      <button
                        onClick={() => handleUninstall(plugin.id)}
                        disabled={isUninstalling}
                        className="text-xs px-2.5 py-1 rounded border border-red-300 dark:border-red-700 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                      >
                        {isUninstalling ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="w-3 h-3 border-2 border-red-300 border-t-transparent rounded-full animate-spin" />
                            Removing...
                          </span>
                        ) : (
                          "Uninstall"
                        )}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleInstall(plugin)}
                        disabled={isInstalling || !plugin.downloadUrl}
                        className="text-xs px-2.5 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
                      >
                        {isInstalling ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            Installing...
                          </span>
                        ) : (
                          "Install"
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                  {plugin.description}
                </p>
                <div className="flex flex-wrap gap-1">
                  {plugin.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                {(plugin as any).permissions && (plugin as any).permissions.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                    <p className="text-xs text-gray-400 mb-1">Required permissions:</p>
                    <div className="flex flex-wrap gap-1">
                      {((plugin as any).permissions as string[]).map((p) => (
                        <span
                          key={p}
                          className="text-xs font-mono px-1 py-0.5 rounded bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
