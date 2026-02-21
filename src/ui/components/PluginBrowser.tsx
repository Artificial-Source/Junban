import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  X,
  Search,
  Download,
  Trash2,
  Loader2,
  ExternalLink,
  Shield,
  ArrowLeft,
} from "lucide-react";
import {
  api,
  type PluginInfo,
  type StorePluginInfo,
  type SettingDefinitionInfo,
} from "../api/index.js";
import { usePluginContext } from "../context/PluginContext.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { useIsMobile } from "../hooks/useIsMobile.js";
import { getGradient, formatDownloads } from "./PluginCard.js";
import { PluginSettings } from "./PluginCard.js";

// ── Types ────────────────────────────────────────────

interface BrowserPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  icon?: string;
  repository?: string;
  downloadUrl?: string;
  tags: string[];
  downloads?: number;
  longDescription?: string;
  installed: boolean;
  enabled: boolean;
  builtin: boolean;
  permissions: string[];
  settings: SettingDefinitionInfo[];
}

type FilterTab = "all" | "installed" | "not-installed";

// ── Props ────────────────────────────────────────────

interface PluginBrowserProps {
  open: boolean;
  onClose: () => void;
}

// ── Data merging ─────────────────────────────────────

function mergePlugins(installed: PluginInfo[], store: StorePluginInfo[]): BrowserPlugin[] {
  const installedMap = new Map(installed.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const result: BrowserPlugin[] = [];

  // Store plugins are the base
  for (const sp of store) {
    seen.add(sp.id);
    const ip = installedMap.get(sp.id);
    result.push({
      id: sp.id,
      name: sp.name,
      description: sp.description,
      author: sp.author,
      version: sp.version,
      icon: sp.icon ?? ip?.icon,
      repository: sp.repository,
      downloadUrl: sp.downloadUrl,
      tags: sp.tags,
      downloads: sp.downloads,
      longDescription: sp.longDescription,
      installed: !!ip,
      enabled: ip?.enabled ?? false,
      builtin: ip?.builtin ?? false,
      permissions: ip?.permissions ?? (sp as any).permissions ?? [],
      settings: ip?.settings ?? [],
    });
  }

  // Installed-only plugins (not in store) appended
  for (const ip of installed) {
    if (!seen.has(ip.id)) {
      result.push({
        id: ip.id,
        name: ip.name,
        description: ip.description,
        author: ip.author,
        version: ip.version,
        icon: ip.icon,
        tags: [],
        installed: true,
        enabled: ip.enabled,
        builtin: ip.builtin,
        permissions: ip.permissions,
        settings: ip.settings,
      });
    }
  }

  return result;
}

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

// ── PluginListItem ───────────────────────────────────

function PluginListItem({
  plugin,
  selected,
  onClick,
}: {
  plugin: BrowserPlugin;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 border-b border-border/50 transition-colors ${
        selected
          ? "bg-accent/10 border-l-2 border-l-accent"
          : "hover:bg-surface-secondary border-l-2 border-l-transparent"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className="text-lg mt-0.5 shrink-0">{plugin.icon || "🧩"}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-on-surface truncate">{plugin.name}</span>
            {plugin.installed && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium">
                {plugin.enabled ? "Enabled" : "Installed"}
              </span>
            )}
            {plugin.builtin && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-muted font-medium">
                Built-in
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-on-surface-muted truncate">{plugin.author}</span>
            {plugin.downloads != null && plugin.downloads > 0 && (
              <span className="text-xs text-on-surface-muted flex items-center gap-0.5 shrink-0">
                <Download size={9} />
                {formatDownloads(plugin.downloads)}
              </span>
            )}
          </div>
          <p className="text-xs text-on-surface-muted mt-0.5 line-clamp-1">{plugin.description}</p>
        </div>
      </div>
    </button>
  );
}

// ── PluginDetail ─────────────────────────────────────

function PluginDetail({
  plugin,
  installing,
  uninstalling,
  activating,
  onInstall,
  onUninstall,
  onToggle,
  error,
}: {
  plugin: BrowserPlugin;
  installing: boolean;
  uninstalling: boolean;
  activating: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onToggle: () => void;
  error: string | null;
}) {
  const [from, to] = getGradient(plugin.id);

  return (
    <div className="flex flex-col">
      {/* Gradient banner */}
      <div className={`h-32 bg-gradient-to-r ${from} ${to} flex items-center justify-center`}>
        <span className="text-5xl drop-shadow-md">{plugin.icon || "🧩"}</span>
      </div>

      <div className="p-5 space-y-5">
        {/* Header */}
        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-on-surface">{plugin.name}</h2>
              <div className="flex items-center gap-2 mt-1 text-xs text-on-surface-muted flex-wrap">
                {plugin.downloads != null && plugin.downloads > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Download size={11} />
                    {formatDownloads(plugin.downloads)}
                  </span>
                )}
                <span>v{plugin.version}</span>
                <span>by {plugin.author}</span>
              </div>
            </div>

            {/* Status badge */}
            {plugin.installed && (
              <span
                className={`shrink-0 text-xs px-2 py-1 rounded-md font-medium ${
                  plugin.enabled
                    ? "bg-success/10 text-success"
                    : "bg-surface-tertiary text-on-surface-muted"
                }`}
              >
                {plugin.enabled ? "Enabled" : "Disabled"}
              </span>
            )}
          </div>

          {/* Repository link */}
          {plugin.repository && (
            <a
              href={plugin.repository}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-hover mt-2"
            >
              <ExternalLink size={11} />
              {plugin.repository.replace(/^https?:\/\//, "")}
            </a>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded-lg">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {plugin.installed ? (
            <>
              {/* Toggle enable/disable */}
              <button
                onClick={onToggle}
                disabled={activating}
                className={`text-sm px-4 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${
                  plugin.enabled
                    ? "border border-border text-on-surface-secondary hover:bg-surface-secondary"
                    : "bg-accent text-white hover:bg-accent-hover"
                } disabled:opacity-50`}
              >
                {activating ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : plugin.enabled ? (
                  "Disable"
                ) : (
                  "Enable"
                )}
              </button>

              {/* Uninstall (not for built-in) */}
              {!plugin.builtin && (
                <button
                  onClick={onUninstall}
                  disabled={uninstalling}
                  className="text-sm px-4 py-1.5 rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {uninstalling ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {uninstalling ? "Removing..." : "Uninstall"}
                </button>
              )}
            </>
          ) : (
            <button
              onClick={onInstall}
              disabled={installing || !plugin.downloadUrl}
              className="text-sm px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1.5 transition-colors"
            >
              {installing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download size={14} />
                  Install
                </>
              )}
            </button>
          )}
        </div>

        {/* Description */}
        <section>
          <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2">
            Description
          </h3>
          <p className="text-sm text-on-surface-secondary leading-relaxed">
            {plugin.longDescription || plugin.description}
          </p>
        </section>

        {/* Permissions */}
        {plugin.permissions.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2 flex items-center gap-1">
              <Shield size={12} />
              Permissions
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {plugin.permissions.map((p) => (
                <span
                  key={p}
                  className="text-xs font-mono px-2 py-1 rounded bg-warning/10 text-warning"
                >
                  {p}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Tags */}
        {plugin.tags.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2">
              Tags
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {plugin.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-1 rounded-md bg-surface-tertiary text-on-surface-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Settings (only if installed + enabled + has settings) */}
        {plugin.installed && plugin.enabled && plugin.settings.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2">
              Settings
            </h3>
            <PluginSettings pluginId={plugin.id} definitions={plugin.settings} />
          </section>
        )}
      </div>
    </div>
  );
}
