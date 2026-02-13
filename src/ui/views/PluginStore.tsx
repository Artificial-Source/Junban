import { useState, useEffect } from "react";
import { api, type StorePluginInfo } from "../api.js";
import { usePluginContext } from "../context/PluginContext.js";

export function PluginStore() {
  const [storePlugins, setStorePlugins] = useState<StorePluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const { plugins: installedPlugins } = usePluginContext();

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

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Plugin Store</h1>
      <p className="text-gray-500 mb-6 text-sm">Browse community plugins for Docket.</p>

      {loading ? (
        <p className="text-gray-400">Loading plugins...</p>
      ) : storePlugins.length === 0 ? (
        <p className="text-gray-400">No plugins available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {storePlugins.map((plugin) => (
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
                {installedIds.has(plugin.id) && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    Installed
                  </span>
                )}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
