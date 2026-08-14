/**
 * Community plugin registry browser — list/search/filter/detail/install.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  Calendar,
  Download,
  ExternalLink,
  List,
  Loader2,
  Puzzle,
  Search,
  Shield,
  Target,
  Timer,
  X,
  Zap,
} from "lucide-react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useIsMobile } from "../../hooks/useIsMobile";
import { createPluginOperationId } from "../operation-id";
import { arePermissionsFullyGranted } from "../parsers";
import * as transport from "../transport";
import type { InstalledPlugin, RegistryEntry } from "../types";

export type FilterTab = "all" | "installed" | "not-installed";

export type BrowserPlugin = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  capabilities: string[];
  packageSha256: string;
  installed: boolean;
  enabled?: boolean;
  builtin?: boolean;
  longDescription?: string;
  icon?: string;
  downloads?: number;
  repository?: string;
  settings?: Array<{ id: string; label: string; value: string | number | boolean }>;
  /** Exact installed authority for mutations and permission review. */
  installedPlugin?: InstalledPlugin;
};

function mergePlugins(
  installed: InstalledPlugin[],
  registry: RegistryEntry[],
  fixtureExtras?: BrowserPlugin[],
): BrowserPlugin[] {
  const installedMap = new Map(installed.map((p) => [p.pluginId, p]));
  const result: BrowserPlugin[] = [];

  const pushRegistryLike = (entry: {
    id: string;
    name: string;
    description: string;
    author: string;
    version: string;
    tags: string[];
    capabilities: string[];
    packageSha256: string;
    longDescription?: string;
    icon?: string;
    downloads?: number;
    repository?: string;
  }) => {
    const local = installedMap.get(entry.id);
    result.push({
      ...entry,
      installed: Boolean(local),
      enabled: local?.desiredEnabled,
      builtin: local?.builtin,
      installedPlugin: local,
    });
  };

  for (const entry of registry) {
    pushRegistryLike({
      id: entry.pluginId,
      name: entry.name,
      description: entry.description,
      author: entry.author,
      version: entry.version,
      tags: entry.searchTags,
      capabilities: entry.requestedCapabilities,
      packageSha256: entry.packageSha256,
    });
  }

  if (fixtureExtras?.length) {
    const seen = new Set(result.map((p) => p.id));
    for (const extra of fixtureExtras) {
      if (seen.has(extra.id)) continue;
      pushRegistryLike(extra);
    }
  }

  // When the registry produced no rows (error/offline), list installed plugins.
  if (result.length === 0) {
    for (const local of installed) {
      result.push({
        id: local.pluginId,
        name: local.name,
        description: local.description,
        author: local.author ?? (local.builtin ? "ASF" : local.publisherKeyId.slice(0, 12)),
        version: local.version,
        tags: [],
        capabilities: local.requestedPermissions.map((p) =>
          p.capability === "tasks:read"
            ? "task:read"
            : p.capability === "tasks:write"
              ? "task:write"
              : p.capability,
        ),
        packageSha256: local.packageSha256,
        installed: true,
        enabled: local.desiredEnabled,
        builtin: local.builtin,
        icon: local.icon,
        installedPlugin: local,
        settings:
          local.pluginId === "pomodoro"
            ? [
                { id: "workMinutes", label: "Work Duration", value: 25 },
                { id: "breakMinutes", label: "Break Duration", value: 5 },
                { id: "longBreakMinutes", label: "Long Break Duration", value: 15 },
                {
                  id: "sessionsBeforeLongBreak",
                  label: "Sessions Before Long Break",
                  value: 4,
                },
              ]
            : undefined,
      });
    }
  }

  return result;
}

function PluginGlyph({ id, size = 16 }: { id: string; size?: number }) {
  if (id.includes("pomodoro") || (id.includes("timer") && !id.includes("sample")))
    return <Timer size={size} />;
  if (id.includes("calendar")) return <Calendar size={size} />;
  if (id.includes("stats")) return <BarChart3 size={size} />;
  if (id.includes("focus")) return <Target size={size} />;
  if (id.includes("export") || id.includes("markdown")) return <List size={size} />;
  if (id.includes("status") || id.includes("badge")) return <Zap size={size} />;
  return <Puzzle size={size} />;
}

const GRADIENT_PALETTE = [
  "from-violet-500 to-purple-600",
  "from-blue-500 to-cyan-500",
  "from-emerald-500 to-teal-500",
  "from-orange-500 to-amber-500",
  "from-rose-500 to-pink-500",
  "from-indigo-500 to-blue-500",
  "from-fuchsia-500 to-purple-500",
  "from-sky-500 to-indigo-500",
  "from-lime-500 to-green-500",
  "from-red-500 to-orange-500",
  "from-teal-500 to-cyan-500",
  "from-pink-500 to-rose-500",
] as const;

function heroGradient(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return GRADIENT_PALETTE[Math.abs(hash) % GRADIENT_PALETTE.length]!;
}

function formatDownloads(count?: number): string {
  if (count === undefined) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export function PluginBrowser({
  open,
  onClose,
  installedPlugins,
  onInstalledChange,
  onReviewPermissions,
  fixtureEntries,
  fixtureMode,
  initialSearch = "",
  initialFilter = "all",
  initialSelectedId = null,
}: {
  open: boolean;
  onClose: () => void;
  installedPlugins: InstalledPlugin[];
  onInstalledChange?: () => void | Promise<void>;
  onReviewPermissions?: (plugin: InstalledPlugin) => void;
  /** Offline visual-fixture registry rows. */
  fixtureEntries?: BrowserPlugin[];
  fixtureMode?: "ready" | "loading" | "error" | "empty";
  initialSearch?: string;
  initialFilter?: FilterTab;
  initialSelectedId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(initialSearch);
  const [filterTab, setFilterTab] = useState<FilterTab>(initialFilter);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [mutating, setMutating] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useFocusTrap(containerRef, open);

  useEffect(() => {
    if (!open) return;
    if (fixtureMode) {
      setLoading(fixtureMode === "loading");
      setStoreError(
        fixtureMode === "error"
          ? "Failed to load plugin registry: Plugin registry is temporarily unavailable"
          : null,
      );
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setStoreError(null);
    void transport
      .listRegistry()
      .then((result) => {
        if (cancelled) return;
        setEntries(result.entries);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Plugin registry is temporarily unavailable";
        setStoreError(`Failed to load plugin registry: ${message}`);
        setEntries([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, fixtureMode]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isMobile && selectedId) setSelectedId(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose, isMobile, selectedId]);

  const allPlugins = useMemo(
    () =>
      mergePlugins(installedPlugins, entries, fixtureMode === "ready" ? fixtureEntries : undefined),
    [installedPlugins, entries, fixtureEntries, fixtureMode],
  );

  const filteredPlugins = useMemo(() => {
    let list = allPlugins;
    if (filterTab === "installed") list = list.filter((p) => p.installed);
    if (filterTab === "not-installed") list = list.filter((p) => !p.installed);
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

  useEffect(() => {
    if (!isMobile && !loading && !selectedId && filteredPlugins.length > 0) {
      setSelectedId(filteredPlugins[0]!.id);
    }
  }, [isMobile, loading, selectedId, filteredPlugins]);

  const handleInstalledToggle = useCallback(
    async (plugin: BrowserPlugin) => {
      if (fixtureMode) return;
      const installed = plugin.installedPlugin;
      if (!installed) {
        setError(`Failed to update ${plugin.name}: installed plugin state is unavailable`);
        return;
      }
      if (
        !installed.desiredEnabled &&
        !arePermissionsFullyGranted(installed.requestedPermissions, installed.grantedPermissions)
      ) {
        onReviewPermissions?.(installed);
        return;
      }

      setError(null);
      setMutating((previous) => new Set(previous).add(installed.pluginId));
      try {
        const options = { operationId: createPluginOperationId() };
        if (installed.desiredEnabled) {
          await transport.disablePlugin(installed.pluginId, options);
        } else {
          await transport.enablePlugin(installed.pluginId, options);
        }
        await onInstalledChange?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        setError(
          `Failed to ${installed.desiredEnabled ? "disable" : "enable"} ${plugin.name}: ${message}`,
        );
      } finally {
        setMutating((previous) => {
          const next = new Set(previous);
          next.delete(installed.pluginId);
          return next;
        });
      }
    },
    [fixtureMode, onInstalledChange, onReviewPermissions],
  );

  const handleInstall = useCallback(
    async (plugin: BrowserPlugin) => {
      if (fixtureMode) return;
      setError(null);
      setInstalling((prev) => new Set(prev).add(plugin.id));
      try {
        await transport.installRegistryEntry(
          plugin.id,
          {
            version: plugin.version,
            expectedPackageSha256: plugin.packageSha256,
          },
          { operationId: createPluginOperationId() },
        );
        await onInstalledChange?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        setError(`Failed to install ${plugin.name}: ${message}`);
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(plugin.id);
          return next;
        });
      }
    },
    [fixtureMode, onInstalledChange],
  );

  if (!open) return null;

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "installed", label: "Installed" },
    { key: "not-installed", label: "Not Installed" },
  ];

  const detail = selectedPlugin ? (
    <PluginDetail
      plugin={selectedPlugin}
      installing={installing.has(selectedPlugin.id)}
      mutating={mutating.has(selectedPlugin.id)}
      onInstall={() => void handleInstall(selectedPlugin)}
      onInstalledToggle={() => void handleInstalledToggle(selectedPlugin)}
      error={error}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-sm text-on-surface-muted">
      Select a plugin to view details
    </div>
  );

  if (isMobile && selectedPlugin) {
    return (
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-browser-mobile-title"
        className="fixed inset-0 z-[60] flex flex-col bg-surface"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="p-1 text-on-surface-muted transition-colors hover:text-on-surface"
            aria-label="Back to plugin list"
          >
            <ArrowLeft size={20} />
          </button>
          <h2
            id="plugin-browser-mobile-title"
            className="truncate text-base font-semibold text-on-surface"
          >
            {selectedPlugin.name}
          </h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-browser-title"
        className={`flex flex-col overflow-hidden border border-border bg-surface shadow-2xl ${
          isMobile ? "h-full w-full" : "h-[90vh] w-full max-w-5xl rounded-xl"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <h1 id="plugin-browser-title" className="text-lg font-bold text-on-surface">
            Community Plugins
          </h1>
          <button
            type="button"
            aria-label="Close community plugins"
            onClick={onClose}
            className="rounded-md p-1.5 text-on-surface-muted hover:bg-surface-secondary hover:text-on-surface"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div
            className={`flex flex-col border-r border-border ${isMobile ? "w-full" : "w-[280px] shrink-0"}`}
          >
            <div className="px-3 pt-3 pb-2">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute top-1/2 left-2.5 -translate-y-1/2 text-on-surface-muted"
                />
                <input
                  ref={searchRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search plugins..."
                  aria-label="Search community plugins"
                  className="w-full rounded-md border border-border bg-surface py-1.5 pr-3 pl-8 text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
                />
              </div>
            </div>

            <div className="flex gap-1 px-3 pb-2">
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setFilterTab(tab.key)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    filterTab === tab.key
                      ? "bg-accent-action text-on-accent-action"
                      : "text-on-surface-muted hover:bg-surface-secondary hover:text-on-surface"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {storeError ? (
                <p role="alert" className="px-3 py-4 text-center text-sm text-error">
                  {storeError}
                </p>
              ) : null}
              {loading ? (
                <div
                  className="flex items-center justify-center py-12"
                  role="status"
                  aria-label="Loading"
                >
                  <Loader2 size={20} className="animate-spin text-on-surface-muted" />
                </div>
              ) : filteredPlugins.length === 0 ? (
                !storeError && (
                  <p className="px-3 py-8 text-center text-sm text-on-surface-muted">
                    {searchQuery ? "No plugins match your search." : "No plugins available."}
                  </p>
                )
              ) : (
                filteredPlugins.map((plugin) => {
                  const showInstalledStatus =
                    plugin.builtin ||
                    (plugin.installed &&
                      plugin.tags.length === 0 &&
                      plugin.downloads === undefined);
                  return (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => setSelectedId(plugin.id)}
                      className={`w-full border-b border-l-2 border-border/50 px-3 py-2.5 text-left transition-colors ${
                        selectedId === plugin.id
                          ? "border-l-accent-action bg-accent-action/10"
                          : "border-l-transparent hover:bg-surface-secondary"
                      }`}
                    >
                      <span className="flex items-start gap-2.5">
                        <span className="mt-0.5 shrink-0">
                          <PluginGlyph id={plugin.id} size={18} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-on-surface">
                              {plugin.name}
                            </span>
                            {showInstalledStatus && plugin.installed ? (
                              <span className="shrink-0 rounded bg-accent-action/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
                                {plugin.enabled ? "Enabled" : "Installed"}
                              </span>
                            ) : null}
                            {plugin.builtin ? (
                              <span className="shrink-0 rounded bg-surface-tertiary px-1.5 py-0.5 text-[10px] font-medium text-on-surface-muted">
                                Built-in
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5">
                            <span className="truncate text-xs text-on-surface-muted">
                              {plugin.author}
                            </span>
                            {plugin.downloads !== undefined && plugin.downloads > 0 ? (
                              <span className="flex shrink-0 items-center gap-0.5 text-xs text-on-surface-muted">
                                <Download size={9} aria-hidden="true" />
                                {formatDownloads(plugin.downloads)}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block line-clamp-1 text-xs text-on-surface-muted">
                            {plugin.description}
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {!isMobile ? <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div> : null}
        </div>
      </div>
    </div>
  );
}

function PluginDetail({
  plugin,
  installing,
  mutating,
  onInstall,
  onInstalledToggle,
  error,
}: {
  plugin: BrowserPlugin;
  installing: boolean;
  mutating: boolean;
  onInstall: () => void;
  onInstalledToggle: () => void;
  error: string | null;
}) {
  const gradient = heroGradient(plugin.id);
  const downloads = formatDownloads(plugin.downloads);
  const installed = plugin.installedPlugin;
  const needsPermissionReview = Boolean(
    installed &&
    !installed.desiredEnabled &&
    !arePermissionsFullyGranted(installed.requestedPermissions, installed.grantedPermissions),
  );

  return (
    <div data-testid="plugin-detail" className="flex flex-col">
      <div className={`flex h-32 items-center justify-center bg-gradient-to-r ${gradient}`}>
        <span className="drop-shadow-md">
          <PluginGlyph id={plugin.id} size={56} />
        </span>
      </div>

      <div className="space-y-5 p-5">
        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-on-surface">{plugin.name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-on-surface-muted">
                {downloads ? (
                  <span className="flex items-center gap-0.5">
                    <Download size={11} aria-hidden="true" />
                    {downloads}
                  </span>
                ) : null}
                <span>v{plugin.version}</span>
                <span>by {plugin.author}</span>
              </div>
            </div>

            {plugin.installed ? (
              <span
                className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium ${
                  plugin.enabled
                    ? "bg-success/10 text-success"
                    : "bg-surface-tertiary text-on-surface-muted"
                }`}
              >
                {plugin.enabled ? "Enabled" : "Disabled"}
              </span>
            ) : null}
          </div>

          {plugin.repository ? (
            <div className="mt-2 inline-flex items-center gap-1 text-xs text-accent-foreground">
              <ExternalLink size={11} aria-hidden="true" />
              <span>{plugin.repository.replace(/^https?:\/\//, "")}</span>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-lg border border-error/20 bg-error/10 p-3" role="alert">
            <p className="text-sm text-error">{error}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {plugin.installed ? (
            <button
              type="button"
              disabled={mutating}
              onClick={onInstalledToggle}
              className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                plugin.enabled
                  ? "border border-border text-on-surface-secondary hover:bg-surface-secondary"
                  : "bg-accent-action text-on-accent-action hover:bg-accent-action-hover"
              }`}
            >
              {mutating
                ? plugin.enabled
                  ? "Disabling..."
                  : "Enabling..."
                : needsPermissionReview
                  ? "Review permissions"
                  : plugin.enabled
                    ? "Disable"
                    : "Enable"}
            </button>
          ) : (
            <button
              type="button"
              disabled={installing || !plugin.packageSha256}
              onClick={onInstall}
              className="flex items-center gap-1.5 rounded-md bg-accent-action px-4 py-1.5 text-sm text-on-accent-action transition-colors hover:bg-accent-action-hover disabled:opacity-50"
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

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wider text-on-surface-secondary uppercase">
            Description
          </h3>
          <p className="text-sm leading-relaxed text-on-surface-secondary">
            {plugin.longDescription ?? plugin.description}
          </p>
        </section>

        {plugin.capabilities.length > 0 ? (
          <section>
            <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold tracking-wider text-on-surface-secondary uppercase">
              <Shield size={12} aria-hidden="true" />
              Permissions
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {plugin.capabilities.map((capability) => (
                <code
                  key={capability}
                  className="rounded bg-warning/10 px-2 py-1 text-xs text-warning"
                >
                  {capability}
                </code>
              ))}
            </div>
          </section>
        ) : null}

        {plugin.tags.length > 0 ? (
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-on-surface-secondary uppercase">
              Tags
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {plugin.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-surface-tertiary px-2 py-1 text-xs text-on-surface-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {plugin.installed && plugin.enabled && plugin.settings && plugin.settings.length > 0 ? (
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-on-surface-secondary uppercase">
              Settings
            </h3>
            <div className="space-y-3">
              {plugin.settings.map((setting) => (
                <label key={setting.id} className="block">
                  <span className="mb-1 block text-xs font-medium text-on-surface-secondary">
                    {setting.label}
                  </span>
                  <input
                    type={typeof setting.value === "number" ? "number" : "text"}
                    readOnly
                    value={String(setting.value)}
                    className="w-24 rounded border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                  />
                </label>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
