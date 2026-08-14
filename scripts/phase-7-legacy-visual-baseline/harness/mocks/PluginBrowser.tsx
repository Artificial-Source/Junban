import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, Search, Loader2, ArrowLeft } from "lucide-react";
import { api, type StorePluginInfo } from "../api/index.js";
import { sanitizeUrlsInTextForLogging } from "../../utils/url-sanitizer.js";
import { usePluginContext } from "../context/PluginContext.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
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
  // Phase 7 harness: viewport width only (Playwright media emulation is not trusted here).
  const isMobile = typeof window !== "undefined" ? window.innerWidth <= 767 : false;

  const {
    plugins: installedPlugins,
    reconciliationState,
    reconcileAppliedMutation,
    retryPluginReconciliation,
  } = usePluginContext();
  const [storePlugins, setStorePlugins] = useState<StorePluginInfo[]>([]);
  const [storeError, setStoreError] = useState<string | null>(null);
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
    setStoreError(null);
    api
      .getPluginStore()
      .then((data) => {
        setStorePlugins(data.plugins ?? []);
        setLoading(false);
      })
      .catch((err) => {
        const message = sanitizeUrlsInTextForLogging(
          err instanceof Error ? err.message : "Plugin registry is temporarily unavailable",
        );
        console.warn("[plugins] Failed to load plugin registry:", message);
        setStorePlugins([]);
        setStoreError(`Failed to load plugin registry: ${message}`);
        setLoading(false);
      });
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

  // Auto-select first plugin on desktop when none selected and store finished loading.
  useEffect(() => {
    if (!isMobile && !loading && !selectedId && filteredPlugins.length > 0) {
      setSelectedId(filteredPlugins[0].id);
    }
  }, [isMobile, loading, selectedId, filteredPlugins]);

  // ── Handlers ─────────────────────────────────────

  const handleInstall = useCallback(
    async (plugin: BrowserPlugin) => {
      if (reconciliationState) return;
      if (!plugin.downloadUrl || !plugin.sha256) {
        setError(`No verified package is available for ${plugin.name}`);
        return;
      }
      setError(null);
      setInstalling((previous) => new Set(previous).add(plugin.id));
      let applied = false;
      try {
        await api.installPlugin(plugin.id, plugin.downloadUrl, plugin.sha256);
        applied = true;
      } catch (mutationError) {
        const message = sanitizeUrlsInTextForLogging(
          mutationError instanceof Error ? mutationError.message : "unknown error",
        );
        setError(`Failed to install ${plugin.name}: ${message}`);
      } finally {
        setInstalling((previous) => {
          const next = new Set(previous);
          next.delete(plugin.id);
          return next;
        });
      }
      if (applied) await reconcileAppliedMutation(`${plugin.name} installation applied`);
    },
    [reconciliationState, reconcileAppliedMutation],
  );

  const handleUninstall = useCallback(
    async (pluginId: string) => {
      if (reconciliationState) return;
      setError(null);
      setUninstalling((previous) => new Set(previous).add(pluginId));
      let applied = false;
      try {
        await api.uninstallPlugin(pluginId);
        applied = true;
      } catch (mutationError) {
        const message = sanitizeUrlsInTextForLogging(
          mutationError instanceof Error ? mutationError.message : "unknown error",
        );
        setError(`Failed to uninstall: ${message}`);
      } finally {
        setUninstalling((previous) => {
          const next = new Set(previous);
          next.delete(pluginId);
          return next;
        });
      }
      if (applied) await reconcileAppliedMutation("Plugin uninstall applied");
    },
    [reconciliationState, reconcileAppliedMutation],
  );

  const handleToggle = useCallback(
    async (pluginId: string) => {
      if (reconciliationState) return;
      setError(null);
      setActivating((previous) => new Set(previous).add(pluginId));
      let applied = false;
      try {
        await api.togglePlugin(pluginId);
        applied = true;
      } catch (mutationError) {
        const message = sanitizeUrlsInTextForLogging(
          mutationError instanceof Error ? mutationError.message : "unknown error",
        );
        setError(`Failed to toggle: ${message}`);
      } finally {
        setActivating((previous) => {
          const next = new Set(previous);
          next.delete(pluginId);
          return next;
        });
      }
      if (applied) await reconcileAppliedMutation("Plugin state change applied");
    },
    [reconciliationState, reconcileAppliedMutation],
  );

  if (!open) return null;

  const reconciliationNotice = reconciliationState?.error && (
    <div className="mx-4 mt-3 rounded-lg border border-error/30 bg-error/5 p-3" role="alert">
      <p className="text-sm text-error">
        {reconciliationState.message}; refresh pending. Showing the last known plugin data.{" "}
        {reconciliationState.error}
      </p>
      <button
        type="button"
        className="mt-2 rounded border border-current px-2.5 py-1 text-xs font-medium text-error hover:bg-error/10"
        onClick={() => void retryPluginReconciliation()}
      >
        Retry refresh
      </button>
    </div>
  );

  // ── Mobile detail view ───────────────────────────
  if (isMobile && selectedPlugin) {
    return (
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-browser-mobile-title"
        className="fixed inset-0 z-[60] bg-surface flex flex-col"
      >
        {/* Mobile header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <button
            onClick={() => setSelectedId(null)}
            className="p-1 text-on-surface-muted hover:text-on-surface transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <h2
            id="plugin-browser-mobile-title"
            className="text-base font-semibold text-on-surface truncate"
          >
            {selectedPlugin.name}
          </h2>
        </div>

        {reconciliationNotice}
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
            controlsDisabled={reconciliationState !== null}
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-browser-title"
        className={`bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden ${
          isMobile ? "w-full h-full rounded-none" : "max-w-5xl w-full h-[90vh]"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h1 id="plugin-browser-title" className="text-lg font-bold text-on-surface">
            Community Plugins
          </h1>
          <button
            type="button"
            aria-label="Close community plugins"
            onClick={onClose}
            className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {reconciliationNotice}

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
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
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
                      ? "bg-accent-action text-on-accent-action"
                      : "text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Plugin list */}
            <div className="flex-1 overflow-y-auto">
              {storeError && (
                <p role="alert" className="text-sm text-danger text-center py-4 px-3">
                  {storeError}
                </p>
              )}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={20} className="animate-spin text-on-surface-muted" />
                </div>
              ) : filteredPlugins.length === 0 ? (
                !storeError && (
                  <p className="text-sm text-on-surface-muted text-center py-8 px-3">
                    {searchQuery ? "No plugins match your search." : "No plugins available."}
                  </p>
                )
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
                  controlsDisabled={reconciliationState !== null}
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
