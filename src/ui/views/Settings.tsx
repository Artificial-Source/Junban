import { useState, useEffect, useCallback } from "react";
import { isTauri } from "../../utils/tauri.js";
import {
  Settings as SettingsIcon,
  Palette,
  Bot,
  Puzzle,
  Keyboard,
  Database,
  Info,
  FileText,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import { themeManager } from "../themes/manager.js";
import { useTaskContext } from "../context/TaskContext.js";
import { usePluginContext } from "../context/PluginContext.js";
import { useAIContext } from "../context/AIContext.js";
import { PermissionDialog } from "../components/PermissionDialog.js";
import { api, type PluginInfo, type SettingDefinitionInfo, type AIProviderInfo } from "../api.js";
import type { TaskTemplate, CreateTemplateInput } from "../../core/types.js";
import { exportJSON, exportCSV, exportMarkdown, type ExportData } from "../../core/export.js";
import { parseImport, type ImportPreview } from "../../core/import.js";
import { THEME_VARIABLES, type CustomTheme } from "../../config/themes.js";
import { generateId } from "../../utils/ids.js";
import { shortcutManager } from "../App.js";

export type SettingsTab =
  | "general"
  | "ai"
  | "plugins"
  | "templates"
  | "keyboard"
  | "data"
  | "about";

interface SettingsProps {
  activeTab?: SettingsTab;
  onActiveTabChange?: (tab: SettingsTab) => void;
}

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Palette className="w-4 h-4" /> },
  { id: "ai", label: "AI Assistant", icon: <Bot className="w-4 h-4" /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle className="w-4 h-4" /> },
  { id: "templates", label: "Templates", icon: <FileText className="w-4 h-4" /> },
  { id: "keyboard", label: "Keyboard", icon: <Keyboard className="w-4 h-4" /> },
  { id: "data", label: "Data", icon: <Database className="w-4 h-4" /> },
  { id: "about", label: "About", icon: <Info className="w-4 h-4" /> },
];

const LM_STUDIO_MODEL_LINKS = [
  { label: "liquid/lfm2.5-1.2b", url: "https://lmstudio.ai/models/liquid/lfm2.5-1.2b" },
  { label: "liquid/lfm2-1.2b", url: "https://lmstudio.ai/models/liquid/lfm2-1.2b" },
] as const;

export function Settings({ activeTab: controlledActiveTab, onActiveTabChange }: SettingsProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>("general");
  const activeTab = controlledActiveTab ?? internalActiveTab;
  const [currentTheme, setCurrentTheme] = useState(themeManager.getCurrent());
  const [allThemes, setAllThemes] = useState(themeManager.listThemes());
  const { plugins, refreshPlugins } = usePluginContext();
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [permissionPlugin, setPermissionPlugin] = useState<PluginInfo | null>(null);
  const [editingTheme, setEditingTheme] = useState<CustomTheme | null>(null);
  const [creatingTheme, setCreatingTheme] = useState(false);

  const refreshThemeList = () => {
    setAllThemes(themeManager.listThemes());
    setCurrentTheme(themeManager.getCurrent());
  };

  const handleThemeChange = (themeId: string) => {
    themeManager.setTheme(themeId);
    setCurrentTheme(themeId);
  };

  const handleCreateTheme = () => {
    const id = `custom-${generateId()}`;
    const defaultVars: Record<string, string> = {};
    for (const v of THEME_VARIABLES) {
      const computed = getComputedStyle(document.documentElement).getPropertyValue(v.key).trim();
      if (computed) defaultVars[v.key] = computed;
    }

    setEditingTheme({
      id,
      name: "My Theme",
      type: "light",
      variables: defaultVars,
    });
    setCreatingTheme(true);
  };

  const handleEditTheme = (theme: CustomTheme) => {
    setEditingTheme({ ...theme, variables: { ...theme.variables } });
    setCreatingTheme(false);
  };

  const handleSaveTheme = async (theme: CustomTheme) => {
    themeManager.clearPreview();
    await themeManager.saveCustomTheme(theme);
    themeManager.setTheme(theme.id);
    setEditingTheme(null);
    refreshThemeList();
  };

  const handleCancelThemeEdit = () => {
    themeManager.clearPreview();
    // Re-apply current theme to undo preview
    themeManager.setTheme(currentTheme);
    setEditingTheme(null);
  };

  const handleDeleteTheme = async (id: string) => {
    await themeManager.deleteCustomTheme(id);
    refreshThemeList();
  };

  const handleExportTheme = (theme: CustomTheme) => {
    const json = JSON.stringify(theme, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${theme.name.toLowerCase().replace(/\s+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportTheme = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const parsed = JSON.parse(content);
      if (!parsed.name || !parsed.type || !parsed.variables) {
        return;
      }
      const theme: CustomTheme = {
        id: parsed.id?.startsWith("custom-") ? parsed.id : `custom-${generateId()}`,
        name: parsed.name,
        type: parsed.type === "dark" ? "dark" : "light",
        variables: parsed.variables,
      };
      await themeManager.saveCustomTheme(theme);
      themeManager.setTheme(theme.id);
      refreshThemeList();
    } catch {
      // Invalid theme file
    }
    e.target.value = "";
  };

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

  const handleTabChange = (tab: SettingsTab) => {
    if (controlledActiveTab === undefined) {
      setInternalActiveTab(tab);
    }
    onActiveTabChange?.(tab);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2 text-on-surface">
        <SettingsIcon className="w-6 h-6" />
        Settings
      </h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-accent text-accent"
                : "border-transparent text-on-surface-secondary hover:text-on-surface hover:bg-surface-secondary"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "general" && (
        <>
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-3 text-on-surface">Appearance</h2>

            <div className="flex items-center gap-3 mb-4">
              <select
                value={currentTheme}
                onChange={(e) => handleThemeChange(e.target.value)}
                className="px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              >
                {allThemes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.type})
                  </option>
                ))}
              </select>

              <button
                onClick={handleCreateTheme}
                className="px-3 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary"
              >
                Create Custom Theme
              </button>

              <label className="px-3 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary cursor-pointer">
                Import Theme
                <input type="file" accept=".json" onChange={handleImportTheme} className="hidden" />
              </label>
            </div>

            {/* Custom theme management */}
            {themeManager.customThemes.length > 0 && !editingTheme && (
              <div className="space-y-2 mb-4">
                {themeManager.customThemes.map((ct) => (
                  <div
                    key={ct.id}
                    className="flex items-center justify-between p-2 border border-border rounded-lg"
                  >
                    <span className="text-sm text-on-surface">
                      {ct.name} <span className="text-on-surface-muted text-xs">({ct.type})</span>
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleEditTheme(ct)}
                        className="text-xs text-accent hover:text-accent-hover"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleExportTheme(ct)}
                        className="text-xs text-on-surface-muted hover:text-on-surface-secondary"
                      >
                        Export
                      </button>
                      <button
                        onClick={() => handleDeleteTheme(ct.id)}
                        className="text-xs text-error hover:text-error"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Inline theme editor */}
            {editingTheme && (
              <ThemeEditor
                theme={editingTheme}
                isNew={creatingTheme}
                onSave={handleSaveTheme}
                onCancel={handleCancelThemeEdit}
              />
            )}
          </section>
        </>
      )}

      {activeTab === "ai" && <AIAssistantSettings />}

      {activeTab === "plugins" && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3 text-on-surface">Plugins</h2>
          {plugins.length === 0 ? (
            <p className="text-on-surface-muted">No plugins installed.</p>
          ) : (
            <div className="space-y-3">
              {plugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
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
          )}
        </section>
      )}

      {activeTab === "templates" && <TemplatesSection />}

      {activeTab === "keyboard" && <KeyboardShortcutsSection />}

      {activeTab === "data" && (
        <>
          <StorageSection />
          <DataSection />
        </>
      )}

      {activeTab === "about" && <AboutSection />}

      {permissionPlugin && (
        <PermissionDialog
          pluginName={permissionPlugin.name}
          permissions={permissionPlugin.permissions}
          onApprove={handleApprove}
          onCancel={() => setPermissionPlugin(null)}
        />
      )}
    </div>
  );
}

function PluginCard({
  plugin,
  expanded,
  onToggleExpand,
  onRequestApproval,
  onRevoke,
}: {
  plugin: PluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onRequestApproval: () => void;
  onRevoke: () => void;
}) {
  const isPending = !plugin.enabled && plugin.permissions.length > 0;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={onToggleExpand}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-surface-secondary"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-on-surface">{plugin.name}</span>
            <span className="text-xs text-on-surface-muted">v{plugin.version}</span>
            {isPending ? (
              <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                Needs Approval
              </span>
            ) : (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${
                  plugin.enabled
                    ? "bg-success/10 text-success"
                    : "bg-surface-tertiary text-on-surface-muted"
                }`}
              >
                {plugin.enabled ? "Active" : "Inactive"}
              </span>
            )}
          </div>
          <p className="text-xs text-on-surface-muted mt-0.5">
            by {plugin.author} — {plugin.description}
          </p>
        </div>
        <span className="text-on-surface-muted text-sm">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-4 py-3 border-t border-border space-y-3">
          {plugin.permissions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-on-surface-secondary mb-1">Permissions:</p>
              <div className="flex flex-wrap gap-1">
                {plugin.permissions.map((p) => (
                  <span
                    key={p}
                    className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-secondary"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {isPending && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRequestApproval();
              }}
              className="px-3 py-1 text-xs bg-accent text-white rounded hover:bg-accent-hover"
            >
              Approve Permissions
            </button>
          )}

          {plugin.enabled && plugin.permissions.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRevoke();
              }}
              className="px-3 py-1 text-xs text-error border border-error/30 rounded hover:bg-error/10"
            >
              Revoke Permissions
            </button>
          )}

          {plugin.settings.length > 0 ? (
            <PluginSettings pluginId={plugin.id} definitions={plugin.settings} />
          ) : (
            <p className="text-xs text-on-surface-muted">No configurable settings.</p>
          )}
        </div>
      )}
    </div>
  );
}

function AIAssistantSettings() {
  const { config, isConfigured, updateConfig, refreshConfig } = useAIContext();
  const [providers, setProviders] = useState<AIProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .listAIProviders()
      .then(setProviders)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (config && !loaded) {
      setProvider(config.provider ?? "");
      setModel(config.model ?? "");
      setBaseUrl(config.baseUrl ?? "");
      setLoaded(true);
    }
  }, [config, loaded]);

  const currentProvider = providers.find((p) => p.name === provider);
  const suggestedModels = currentProvider?.suggestedModels ?? [];
  const modelInputListId = provider ? `ai-model-suggestions-${provider}` : undefined;

  const handleProviderChange = async (newProvider: string) => {
    setProvider(newProvider);
    setApiKey("");
    const prov = providers.find((p) => p.name === newProvider);
    setModel(prov?.defaultModel ?? "");
    setBaseUrl(prov?.defaultBaseUrl ?? "");

    if (!newProvider) {
      await updateConfig({ provider: "", apiKey: "", model: "", baseUrl: "" });
    }
  };

  const handleSave = async () => {
    await updateConfig({
      provider: provider || undefined,
      apiKey: apiKey || undefined,
      model: model || undefined,
      baseUrl: baseUrl || undefined,
    });
    setApiKey("");
    await refreshConfig();
  };

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3 text-on-surface">AI Assistant</h2>

      <div className="space-y-4 max-w-md">
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">
            Provider
          </label>
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
          >
            <option value="">None (disabled)</option>
            {providers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.displayName}
                {p.pluginId ? " (plugin)" : ""}
              </option>
            ))}
          </select>
        </div>

        {provider && (
          <>
            {currentProvider?.needsApiKey && (
              <div>
                <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                  API Key
                  {config?.hasApiKey && (
                    <span className="font-normal text-success ml-2">Saved</span>
                  )}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config?.hasApiKey ? "Enter new key to update" : "Enter API key"}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={currentProvider?.defaultModel ?? ""}
                list={modelInputListId}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              />
              {suggestedModels.length > 0 && modelInputListId && (
                <>
                  <datalist id={modelInputListId}>
                    {suggestedModels.map((suggestion) => (
                      <option key={suggestion} value={suggestion} />
                    ))}
                  </datalist>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {suggestedModels.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => setModel(suggestion)}
                        className="px-2 py-1 text-xs rounded border border-border bg-surface-secondary text-on-surface-secondary hover:text-on-surface"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {provider === "lmstudio" && (
                <p className="mt-2 text-xs text-on-surface-muted">
                  Suggested models:{" "}
                  {LM_STUDIO_MODEL_LINKS.map((modelLink, index) => (
                    <span key={modelLink.label}>
                      {index > 0 && " or "}
                      <a
                        href={modelLink.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:text-accent-hover"
                      >
                        {modelLink.label}
                      </a>
                    </span>
                  ))}
                </p>
              )}
            </div>

            {currentProvider?.showBaseUrl && (
              <div>
                <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                  Base URL
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={currentProvider?.defaultBaseUrl ?? ""}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                />
              </div>
            )}

            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover"
            >
              Save
            </button>

            <p className={`text-xs ${isConfigured ? "text-success" : "text-on-surface-muted"}`}>
              {isConfigured ? "Connected" : "Not configured"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function KeyboardShortcutsSection() {
  const [shortcuts, setShortcuts] = useState(shortcutManager.getAll());
  const [recordingId, setRecordingId] = useState<string | null>(null);

  useEffect(() => {
    return shortcutManager.subscribe(() => {
      setShortcuts(shortcutManager.getAll());
    });
  }, []);

  useEffect(() => {
    if (!recordingId) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Skip modifier-only keys
      if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;

      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("ctrl");
      if (e.altKey) parts.push("alt");
      if (e.shiftKey) parts.push("shift");

      let key = e.key.toLowerCase();
      if (key === " ") key = "space";
      if (key === "escape") {
        setRecordingId(null);
        return;
      }
      parts.push(key);

      const combo = parts.join("+");
      const result = shortcutManager.rebind(recordingId, combo);
      if (result.ok) {
        const json = shortcutManager.toJSON();
        api.setAppSetting("keyboard_shortcuts", JSON.stringify(json));
      }
      setRecordingId(null);
    };

    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [recordingId]);

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3 text-on-surface">Keyboard Shortcuts</h2>
      <div className="space-y-2 max-w-lg">
        {shortcuts.map((s) => (
          <div key={s.id} className="flex items-center justify-between py-1.5">
            <span className="text-sm text-on-surface-secondary">{s.description}</span>
            <div className="flex items-center gap-2">
              <kbd
                className={`px-2 py-0.5 text-xs rounded border ${
                  recordingId === s.id
                    ? "border-accent bg-accent/10 text-accent animate-pulse"
                    : "border-border bg-surface-secondary text-on-surface-secondary"
                }`}
              >
                {recordingId === s.id ? "Press keys..." : s.currentKey}
              </kbd>
              <button
                onClick={() => setRecordingId(recordingId === s.id ? null : s.id)}
                className="text-xs text-accent hover:text-accent-hover"
              >
                {recordingId === s.id ? "Cancel" : "Edit"}
              </button>
              {s.currentKey !== s.defaultKey && (
                <button
                  onClick={() => {
                    shortcutManager.resetToDefault(s.id);
                    const json = shortcutManager.toJSON();
                    api.setAppSetting("keyboard_shortcuts", JSON.stringify(json));
                  }}
                  className="text-xs text-on-surface-muted hover:text-on-surface-secondary"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StorageSection() {
  const [storageInfo, setStorageInfo] = useState<{ mode: string; path: string } | null>(null);

  useEffect(() => {
    api
      .getStorageInfo()
      .then(setStorageInfo)
      .catch(() => {});
  }, []);

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3 text-on-surface">Storage</h2>
      {storageInfo ? (
        <div className="space-y-2 max-w-md">
          <div className="flex items-center gap-3">
            <span className="text-sm text-on-surface-secondary">Mode:</span>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-surface-secondary text-on-surface-secondary">
              {storageInfo.mode === "markdown" ? "Markdown Files" : "SQLite"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-on-surface-secondary">Path:</span>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-surface-secondary text-on-surface-secondary">
              {storageInfo.path}
            </span>
          </div>
          <p className="text-xs text-on-surface-muted mt-2">
            {storageInfo.mode === "markdown"
              ? "Tasks are stored as .md files with YAML frontmatter. Git-friendly and human-readable."
              : "Tasks are stored in a local SQLite database. Fast queries and structured data."}
          </p>
          <p className="text-xs text-on-surface-muted">
            Storage mode is set via the STORAGE_MODE environment variable. Switching modes requires
            restart. Data is not automatically migrated — use Export then Import to transfer.
          </p>
        </div>
      ) : (
        <p className="text-sm text-on-surface-muted">Loading storage info...</p>
      )}
    </section>
  );
}

function DataSection() {
  const [exporting, setExporting] = useState(false);
  const [importState, setImportState] = useState<"idle" | "previewing" | "importing" | "done">(
    "idle",
  );
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; errors: string[] } | null>(
    null,
  );
  const [importError, setImportError] = useState<string | null>(null);
  const { refreshTasks } = useTaskContext();

  const handleExport = async (format: "json" | "csv" | "markdown") => {
    setExporting(true);
    try {
      const data = await api.exportAllData();
      let content: string;
      let filename: string;
      let mimeType: string;

      if (format === "json") {
        const exportData: ExportData = {
          ...data,
          exportedAt: new Date().toISOString(),
          version: "1.0",
        };
        content = exportJSON(exportData);
        filename = `docket-export-${new Date().toISOString().split("T")[0]}.json`;
        mimeType = "application/json";
      } else if (format === "csv") {
        content = exportCSV(data.tasks);
        filename = `docket-tasks-${new Date().toISOString().split("T")[0]}.csv`;
        mimeType = "text/csv";
      } else {
        content = exportMarkdown(data.tasks);
        filename = `docket-tasks-${new Date().toISOString().split("T")[0]}.md`;
        mimeType = "text/markdown";
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportError(null);
    setImportResult(null);

    try {
      const content = await file.text();
      const preview = parseImport(content);

      if (preview.tasks.length === 0 && preview.warnings.length > 0) {
        setImportError(preview.warnings[0]);
        return;
      }

      setImportPreview(preview);
      setImportState("previewing");
    } catch {
      setImportError("Failed to read file");
    }

    // Reset file input
    e.target.value = "";
  };

  const handleImport = async () => {
    if (!importPreview) return;

    setImportState("importing");
    try {
      const result = await api.importTasks(importPreview.tasks);
      setImportResult(result);
      setImportState("done");
      refreshTasks();
    } catch {
      setImportError("Failed to import tasks");
      setImportState("idle");
    }
  };

  const handleImportReset = () => {
    setImportState("idle");
    setImportPreview(null);
    setImportResult(null);
    setImportError(null);
  };

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3 text-on-surface">Data</h2>

      <div className="mb-4">
        <h3 className="text-sm font-medium mb-2 text-on-surface-secondary">Export</h3>
        <div className="flex gap-3">
          <button
            onClick={() => handleExport("json")}
            disabled={exporting}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary disabled:opacity-50"
          >
            Export JSON
          </button>
          <button
            onClick={() => handleExport("csv")}
            disabled={exporting}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            onClick={() => handleExport("markdown")}
            disabled={exporting}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary disabled:opacity-50"
          >
            Export Markdown
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-on-surface-secondary">Import</h3>

        {importState === "idle" && (
          <div>
            <label className="inline-block px-4 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary cursor-pointer">
              Choose File
              <input
                type="file"
                accept=".json,.txt,.md"
                onChange={handleFileSelect}
                className="hidden"
              />
            </label>
            <span className="ml-2 text-xs text-on-surface-muted">
              Supports Docket JSON, Todoist JSON, and Markdown/text
            </span>
            {importError && <p className="mt-2 text-xs text-error">{importError}</p>}
          </div>
        )}

        {importState === "previewing" && importPreview && (
          <div className="border border-border rounded-lg p-4 max-w-md">
            <p className="text-sm font-medium mb-2 text-on-surface">
              Import Preview
              <span className="font-normal text-on-surface-muted ml-2">
                ({importPreview.format})
              </span>
            </p>
            <div className="space-y-1 text-xs text-on-surface-secondary mb-3">
              <p>
                {importPreview.tasks.length} task{importPreview.tasks.length !== 1 ? "s" : ""}
              </p>
              {importPreview.projects.length > 0 && (
                <p>
                  {importPreview.projects.length} project
                  {importPreview.projects.length !== 1 ? "s" : ""}:{" "}
                  {importPreview.projects.join(", ")}
                </p>
              )}
              {importPreview.tags.length > 0 && (
                <p>
                  {importPreview.tags.length} tag{importPreview.tags.length !== 1 ? "s" : ""}:{" "}
                  {importPreview.tags.join(", ")}
                </p>
              )}
            </div>
            {importPreview.warnings.length > 0 && (
              <div className="mb-3">
                {importPreview.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-warning">
                    {w}
                  </p>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleImport}
                className="px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover"
              >
                Import
              </button>
              <button
                onClick={handleImportReset}
                className="px-4 py-1.5 text-sm border border-border rounded-lg hover:bg-surface-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {importState === "importing" && (
          <p className="text-sm text-on-surface-muted">Importing tasks...</p>
        )}

        {importState === "done" && importResult && (
          <div className="border border-success/30 rounded-lg p-4 max-w-md">
            <p className="text-sm text-success font-medium">
              Successfully imported {importResult.imported} task
              {importResult.imported !== 1 ? "s" : ""}
            </p>
            {importResult.errors.length > 0 && (
              <div className="mt-2">
                {importResult.errors.map((e, i) => (
                  <p key={i} className="text-xs text-error">
                    {e}
                  </p>
                ))}
              </div>
            )}
            <button
              onClick={handleImportReset}
              className="mt-2 text-xs text-accent hover:text-accent-hover"
            >
              Import another file
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ThemeEditor({
  theme,
  isNew,
  onSave,
  onCancel,
}: {
  theme: CustomTheme;
  isNew: boolean;
  onSave: (theme: CustomTheme) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(theme.name);
  const [type, setType] = useState<"light" | "dark">(theme.type);
  const [variables, setVariables] = useState<Record<string, string>>({ ...theme.variables });

  const handleVariableChange = (key: string, value: string) => {
    const updated = { ...variables, [key]: value };
    setVariables(updated);
    // Live preview
    themeManager.previewVariables({ [key]: value });
  };

  const handleSave = () => {
    onSave({ id: theme.id, name, type, variables });
  };

  // Group variables by category
  const groups = new Map<string, (typeof THEME_VARIABLES)[number][]>();
  for (const v of THEME_VARIABLES) {
    if (!groups.has(v.group)) groups.set(v.group, []);
    groups.get(v.group)!.push(v);
  }

  const isColorVar = (key: string) => key.startsWith("--color-");

  return (
    <div className="border border-border rounded-lg p-4">
      <h3 className="text-sm font-medium mb-3 text-on-surface">
        {isNew ? "Create Custom Theme" : `Edit: ${theme.name}`}
      </h3>

      <div className="flex gap-4 mb-4">
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="px-2 py-1 text-sm border border-border rounded bg-surface text-on-surface"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">
            Base Type
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setType("light")}
              className={`px-3 py-1 text-xs rounded border ${
                type === "light"
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-on-surface-muted"
              }`}
            >
              Light
            </button>
            <button
              onClick={() => setType("dark")}
              className={`px-3 py-1 text-xs rounded border ${
                type === "dark"
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-on-surface-muted"
              }`}
            >
              Dark
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-4 mb-4">
        {[...groups.entries()].map(([group, vars]) => (
          <div key={group}>
            <p className="text-xs font-medium text-on-surface-muted mb-2">{group}</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {vars.map((v) => (
                <div key={v.key} className="flex items-center gap-2">
                  {isColorVar(v.key) ? (
                    <input
                      type="color"
                      value={variables[v.key] || "#000000"}
                      onChange={(e) => handleVariableChange(v.key, e.target.value)}
                      className="w-8 h-8 rounded border border-border cursor-pointer"
                    />
                  ) : (
                    <input
                      type="text"
                      value={variables[v.key] || ""}
                      onChange={(e) => handleVariableChange(v.key, e.target.value)}
                      className="w-20 px-1 py-0.5 text-xs border border-border rounded bg-surface text-on-surface"
                    />
                  )}
                  <span className="text-xs text-on-surface-secondary">{v.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!name.trim()}
          className="px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 text-sm border border-border rounded-lg hover:bg-surface-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function PluginSettings({
  pluginId,
  definitions,
}: {
  pluginId: string;
  definitions: SettingDefinitionInfo[];
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getPluginSettings(pluginId);
      setValues(data);
      setLoaded(true);
    } catch {
      // Non-critical
    }
  }, [pluginId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleChange = async (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    await api.updatePluginSetting(pluginId, key, value);
  };

  if (!loaded) {
    return <p className="text-xs text-on-surface-muted">Loading settings...</p>;
  }

  return (
    <div className="space-y-3">
      {definitions.map((def) => (
        <SettingField
          key={def.id}
          definition={def}
          value={values[def.id] ?? def.default}
          onChange={(v) => handleChange(def.id, v)}
        />
      ))}
    </div>
  );
}

function AboutSection() {
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "up-to-date" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const isTauriApp = isTauri();

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateStatus("available");
        setUpdateVersion(update.version);
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  const handleInstallUpdate = async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-3 text-on-surface">About</h2>
      <div className="space-y-2 max-w-md">
        <p className="text-sm text-on-surface-secondary">
          ASF Docket <span className="font-mono text-on-surface-muted">v1.0.0</span>
        </p>
        <p className="text-xs text-on-surface-muted">
          Open-source, AI-native task manager with an Obsidian-style plugin system.
        </p>
        {isTauriApp && (
          <div className="mt-3">
            <button
              onClick={handleCheckUpdate}
              disabled={updateStatus === "checking"}
              className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-surface-secondary disabled:opacity-50"
            >
              {updateStatus === "checking" ? "Checking..." : "Check for Updates"}
            </button>
            {updateStatus === "available" && (
              <div className="mt-2">
                <p className="text-sm text-success">Update available: v{updateVersion}</p>
                <button
                  onClick={handleInstallUpdate}
                  className="mt-1 px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover"
                >
                  Install and Restart
                </button>
              </div>
            )}
            {updateStatus === "up-to-date" && (
              <p className="mt-2 text-sm text-on-surface-muted">You're up to date!</p>
            )}
            {updateStatus === "error" && (
              <p className="mt-2 text-sm text-error">Update check failed.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function SettingField({
  definition,
  value,
  onChange,
}: {
  definition: SettingDefinitionInfo;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-on-surface-secondary mb-1">
        {definition.name}
        {definition.description && (
          <span className="font-normal text-on-surface-muted ml-1">— {definition.description}</span>
        )}
      </label>
      {definition.type === "text" && (
        <input
          type="text"
          value={String(value ?? "")}
          placeholder={definition.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-border rounded bg-surface text-on-surface"
        />
      )}
      {definition.type === "number" && (
        <input
          type="number"
          value={Number(value ?? 0)}
          min={definition.min}
          max={definition.max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 px-2 py-1 text-sm border border-border rounded bg-surface text-on-surface"
        />
      )}
      {definition.type === "boolean" && (
        <button
          onClick={() => onChange(!value)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            value ? "bg-accent" : "bg-surface-tertiary"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              value ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      )}
      {definition.type === "select" && (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="px-2 py-1 text-sm border border-border rounded bg-surface text-on-surface"
        >
          {definition.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ── Templates Section ──

function TemplatesSection() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [editing, setEditing] = useState<TaskTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const loadTemplates = useCallback(() => {
    api.listTemplates().then(setTemplates).catch(console.error);
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const handleDelete = async (id: string) => {
    await api.deleteTemplate(id);
    loadTemplates();
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-on-surface">Task Templates</h2>
        <button
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </div>

      <p className="text-sm text-on-surface-muted mb-4">
        Templates let you quickly create tasks with predefined fields. Use {"{{variable}}"} syntax
        in title and description for dynamic values.
      </p>

      {(creating || editing) && (
        <TemplateForm
          template={editing}
          onSave={() => {
            setCreating(false);
            setEditing(null);
            loadTemplates();
          }}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {templates.length === 0 && !creating ? (
        <p className="text-on-surface-muted text-sm py-4">
          No templates yet. Click &quot;New Template&quot; to create one.
        </p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between px-4 py-3 border border-border rounded-lg bg-surface-secondary"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-on-surface">{t.name}</div>
                <div className="text-sm text-on-surface-secondary truncate">{t.title}</div>
                <div className="flex gap-1.5 mt-1">
                  {t.priority && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                      P{t.priority}
                    </span>
                  )}
                  {t.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent"
                    >
                      #{tag}
                    </span>
                  ))}
                  {t.recurrence && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-success/10 text-success">
                      {t.recurrence}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-3">
                <button
                  onClick={() => {
                    setEditing(t);
                    setCreating(false);
                  }}
                  className="p-1.5 text-on-surface-muted hover:text-on-surface rounded hover:bg-surface-tertiary"
                  title="Edit template"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="p-1.5 text-on-surface-muted hover:text-error rounded hover:bg-surface-tertiary"
                  title="Delete template"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TemplateForm({
  template,
  onSave,
  onCancel,
}: {
  template: TaskTemplate | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [title, setTitle] = useState(template?.title ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [priority, setPriority] = useState<string>(
    template?.priority ? String(template.priority) : "",
  );
  const [tags, setTags] = useState(template?.tags.join(", ") ?? "");
  const [recurrence, setRecurrence] = useState(template?.recurrence ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !title.trim()) return;

    setSaving(true);
    try {
      const input: CreateTemplateInput = {
        name: name.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        priority: priority ? Number(priority) : undefined,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        recurrence: recurrence.trim() || undefined,
      };

      if (template) {
        await api.updateTemplate(template.id, input);
      } else {
        await api.createTemplate(input);
      }
      onSave();
    } catch (err) {
      console.error("Failed to save template:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 p-4 border border-accent/30 rounded-lg bg-surface space-y-3"
    >
      <h3 className="font-medium text-on-surface">{template ? "Edit Template" : "New Template"}</h3>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Bug Report"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
          required
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">
          Title Template
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={"e.g., Fix: {{issue}}"}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
          required
        />
        <p className="text-xs text-on-surface-muted mt-1">
          Use {"{{variable}}"} for dynamic values
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">
          Description (optional)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Task description..."
          rows={2}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent resize-none"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium text-on-surface-secondary mb-1">
            Priority
          </label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
          >
            <option value="">None</option>
            <option value="1">P1 - Urgent</option>
            <option value="2">P2 - High</option>
            <option value="3">P3 - Medium</option>
            <option value="4">P4 - Low</option>
          </select>
        </div>

        <div className="flex-1">
          <label className="block text-sm font-medium text-on-surface-secondary mb-1">
            Recurrence
          </label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
          >
            <option value="">None</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">
          Tags (comma-separated)
        </label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="e.g., bug, frontend"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface rounded-lg hover:bg-surface-secondary transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !name.trim() || !title.trim()}
          className="px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : template ? "Update" : "Create"}
        </button>
      </div>
    </form>
  );
}
