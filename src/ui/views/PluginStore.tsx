import { useState, useEffect, useMemo } from "react";
import { Puzzle, Search, Download, Trash2, Loader2 } from "lucide-react";
import { api, type StorePluginInfo } from "../api.js";
import { usePluginContext } from "../context/PluginContext.js";

interface PluginStoreProps {
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
}

export function PluginStore({
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
}: PluginStoreProps) {
  const [storePlugins, setStorePlugins] = useState<StorePluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [uninstalling, setUninstalling] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const { plugins: installedPlugins, refreshPlugins } = usePluginContext();
  const searchQuery = controlledSearchQuery ?? internalSearchQuery;

  const setSearchQuery = (value: string) => {
    if (controlledSearchQuery === undefined) {
      setInternalSearchQuery(value);
    }
    onSearchQueryChange?.(value);
  };

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
      <div className="flex items-center gap-3 mb-2">
        <Puzzle size={24} className="text-accent" />
        <h1 className="text-2xl font-bold text-on-surface">Plugin Store</h1>
      </div>
      <p className="text-on-surface-muted mb-4 text-sm">Browse community plugins for Docket.</p>

      <div className="mb-6 relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">
          <Search size={16} />
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search plugins..."
          className="w-full max-w-md pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-on-surface-muted">Loading plugins...</p>
      ) : filteredPlugins.length === 0 ? (
        <p className="text-on-surface-muted">
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
                className="border border-border rounded-lg p-4 bg-surface hover:bg-surface-secondary transition-colors"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="font-medium text-sm text-on-surface">{plugin.name}</h3>
                    <p className="text-xs text-on-surface-muted">
                      by {plugin.author} — v{plugin.version}
                    </p>
                  </div>
                  <div>
                    {isInstalled ? (
                      <button
                        onClick={() => handleUninstall(plugin.id)}
                        disabled={isUninstalling}
                        className="text-xs px-2.5 py-1 rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50 flex items-center gap-1 transition-colors"
                      >
                        {isUninstalling ? (
                          <>
                            <Loader2 size={12} className="animate-spin" />
                            Removing...
                          </>
                        ) : (
                          <>
                            <Trash2 size={12} />
                            Uninstall
                          </>
                        )}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleInstall(plugin)}
                        disabled={isInstalling || !plugin.downloadUrl}
                        className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1 transition-colors"
                      >
                        {isInstalling ? (
                          <>
                            <Loader2 size={12} className="animate-spin" />
                            Installing...
                          </>
                        ) : (
                          <>
                            <Download size={12} />
                            Install
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-on-surface-secondary mb-3">{plugin.description}</p>
                <div className="flex flex-wrap gap-1">
                  {plugin.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-1.5 py-0.5 rounded-md bg-surface-tertiary text-on-surface-muted"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                {(plugin as any).permissions && (plugin as any).permissions.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border">
                    <p className="text-xs text-on-surface-muted mb-1">Required permissions:</p>
                    <div className="flex flex-wrap gap-1">
                      {((plugin as any).permissions as string[]).map((p) => (
                        <span
                          key={p}
                          className="text-xs font-mono px-1 py-0.5 rounded-md bg-warning/10 text-warning"
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
