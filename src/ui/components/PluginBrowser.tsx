import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, Search, Loader2, ArrowLeft } from "lucide-react";
import { api, type StorePluginInfo } from "../api/index.js";
import { usePluginContext } from "../context/PluginContext.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { useIsMobile } from "../hooks/useIsMobile.js";
import type {
  BrowserPlugin,
  FilterTab,
  PluginBrowserProps,
} from "./plugin-browser/plugin-browser-types.js";
import { mergePlugins } from "./plugin-browser/merge-plugins.js";
import { PluginListItem } from "./plugin-browser/PluginListItem.js";
import { PluginDetail } from "./plugin-browser/PluginDetail.js";

// Re-export types for backward compatibility
export type {
  BrowserPlugin,
  FilterTab,
  PluginBrowserProps,
} from "./plugin-browser/plugin-browser-types.js";

// ── Main Component ───────────────────────────────────

export function PluginBrowser({ open, onClose }: PluginBrowserProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const { plugins: installedPlugins, refreshPlugins } = usePluginContext();
  const [storePlugins, setStorePlugins] = useState<StorePluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [uninstalling, setUninstalling] = useState<Set<string>>(new Set());
  const [activating, setActivating] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useFocusTrap(containerRef, open);

  // Fetch store on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .getPluginStore()
      .then((data) => {
        setStorePlugins(data.plugins ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [open]);

  // Auto-focus search on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      // Reset state when closed
      setSearchQuery("");
      setFilterTab("all");
      setSelectedId(null);
      setError(null);
    }
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isMobile && selectedId) {
          setSelectedId(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose, isMobile, selectedId]);

  // Merged + filtered plugins
  const allPlugins = useMemo(
    () => mergePlugins(installedPlugins, storePlugins),
    [installedPlugins, storePlugins],
  );

  const filteredPlugins = useMemo(() => {
    let list = allPlugins;

    // Filter tab
    if (filterTab === "installed") list = list.filter((p) => p.installed);
    if (filterTab === "not-installed") list = list.filter((p) => !p.installed);

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return list;
  }, [allPlugins, filterTab, searchQuery]);

  const selectedPlugin = useMemo(
    () => allPlugins.find((p) => p.id === selectedId) ?? null,
    [allPlugins, selectedId],
  );

  // Auto-select first plugin on desktop when none selected
  useEffect(() => {
    if (!isMobile && !selectedId && filteredPlugins.length > 0) {
      setSelectedId(filteredPlugins[0].id);
    }
  }, [isMobile, selectedId, filteredPlugins]);

  // ── Handlers ─────────────────────────────────────

  const handleInstall = useCallback(
    async (plugin: BrowserPlugin) => {
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
          const n = new Set(prev);
          n.delete(plugin.id);
          return n;
        });
      }
    },
    [refreshPlugins],
  );

  const handleUninstall = useCallback(
    async (pluginId: string) => {
      setError(null);
      setUninstalling((prev) => new Set(prev).add(pluginId));
      try {
        await api.uninstallPlugin(pluginId);
        await refreshPlugins();
      } catch (err) {
        setError(`Failed to uninstall: ${err instanceof Error ? err.message : "unknown error"}`);
      } finally {
        setUninstalling((prev) => {
          const n = new Set(prev);
          n.delete(pluginId);
          return n;
        });
      }
    },
    [refreshPlugins],
  );

  const handleToggle = useCallback(
    async (pluginId: string) => {
      setError(null);
      setActivating((prev) => new Set(prev).add(pluginId));
      try {
        await api.togglePlugin(pluginId);
        await refreshPlugins();
      } catch (err) {
        setError(`Failed to toggle: ${err instanceof Error ? err.message : "unknown error"}`);
      } finally {
        setActivating((prev) => {
          const n = new Set(prev);
          n.delete(pluginId);
          return n;
        });
      }
    },
    [refreshPlugins],
  );

  if (!open) return null;

  // ── Mobile detail view ───────────────────────────
  if (isMobile && selectedPlugin) {
    return (
      <div className="fixed inset-0 z-[60] bg-surface flex flex-col">
        {/* Mobile header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <button
            onClick={() => setSelectedId(null)}
            className="p-1 text-on-surface-muted hover:text-on-surface transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-base font-semibold text-on-surface truncate">
            {selectedPlugin.name}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          <PluginDetail
            plugin={selectedPlugin}
            installing={installing.has(selectedPlugin.id)}
            uninstalling={uninstalling.has(selectedPlugin.id)}
            activating={activating.has(selectedPlugin.id)}
            onInstall={() => handleInstall(selectedPlugin)}
            onUninstall={() => handleUninstall(selectedPlugin.id)}
            onToggle={() => handleToggle(selectedPlugin.id)}
            error={error}
          />
        </div>
      </div>
    );
  }

  // ── Desktop + Mobile list ────────────────────────

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "installed", label: "Installed" },
    { key: "not-installed", label: "Not Installed" },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={containerRef}
        className={`bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden ${
          isMobile ? "w-full h-full rounded-none" : "max-w-5xl w-full h-[90vh]"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h1 className="text-lg font-bold text-on-surface">Community Plugins</h1>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left panel — plugin list */}
          <div
            className={`flex flex-col border-r border-border ${
              isMobile ? "w-full" : "w-[280px] shrink-0"
            }`}
          >
            {/* Search */}
            <div className="px-3 pt-3 pb-2">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-muted"
                />
                <input
                  ref={searchRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search plugins..."
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-1 px-3 pb-2">
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setFilterTab(tab.key)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    filterTab === tab.key
                      ? "bg-accent text-white"
                      : "text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Plugin list */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={20} className="animate-spin text-on-surface-muted" />
                </div>
              ) : filteredPlugins.length === 0 ? (
                <p className="text-sm text-on-surface-muted text-center py-8 px-3">
                  {searchQuery ? "No plugins match your search." : "No plugins available."}
                </p>
              ) : (
                filteredPlugins.map((plugin) => (
                  <PluginListItem
                    key={plugin.id}
                    plugin={plugin}
                    selected={selectedId === plugin.id}
                    onClick={() => setSelectedId(plugin.id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Right panel — detail (desktop only) */}
          {!isMobile && (
            <div className="flex-1 overflow-y-auto">
              {selectedPlugin ? (
                <PluginDetail
                  plugin={selectedPlugin}
                  installing={installing.has(selectedPlugin.id)}
                  uninstalling={uninstalling.has(selectedPlugin.id)}
                  activating={activating.has(selectedPlugin.id)}
                  onInstall={() => handleInstall(selectedPlugin)}
                  onUninstall={() => handleUninstall(selectedPlugin.id)}
                  onToggle={() => handleToggle(selectedPlugin.id)}
                  error={error}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-on-surface-muted text-sm">
                  Select a plugin to view details
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
