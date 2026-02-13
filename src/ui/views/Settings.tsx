import { useState, useEffect, useCallback } from "react";
import { themeManager } from "../themes/manager.js";
import { useTaskContext } from "../context/TaskContext.js";
import { usePluginContext } from "../context/PluginContext.js";
import { useAIContext } from "../context/AIContext.js";
import { PermissionDialog } from "../components/PermissionDialog.js";
import { api, type PluginInfo, type SettingDefinitionInfo, type AIProviderInfo } from "../api.js";
import { exportJSON, exportCSV, exportMarkdown, type ExportData } from "../../core/export.js";
import { parseImport, type ImportPreview } from "../../core/import.js";
import { THEME_VARIABLES, type CustomTheme } from "../../config/themes.js";
import { generateId } from "../../utils/ids.js";
import { shortcutManager } from "../App.js";

export function Settings() {
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

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Settings</h1>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Appearance</h2>

        <div className="flex items-center gap-3 mb-4">
          <select
            value={currentTheme}
            onChange={(e) => handleThemeChange(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {allThemes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.type})
              </option>
            ))}
          </select>

          <button
            onClick={handleCreateTheme}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Create Custom Theme
          </button>

          <label className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
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
                className="flex items-center justify-between p-2 border border-gray-200 dark:border-gray-700 rounded-lg"
              >
                <span className="text-sm">
                  {ct.name} <span className="text-gray-400 text-xs">({ct.type})</span>
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEditTheme(ct)}
                    className="text-xs text-blue-500 hover:text-blue-600"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleExportTheme(ct)}
                    className="text-xs text-gray-500 hover:text-gray-600"
                  >
                    Export
                  </button>
                  <button
                    onClick={() => handleDeleteTheme(ct.id)}
                    className="text-xs text-red-500 hover:text-red-600"
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

      <AIAssistantSettings />

      <StorageSection />

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Plugins</h2>
        {plugins.length === 0 ? (
          <p className="text-gray-500">No plugins installed.</p>
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

      <KeyboardShortcutsSection />

      <DataSection />

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
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={onToggleExpand}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{plugin.name}</span>
            <span className="text-xs text-gray-400">v{plugin.version}</span>
            {isPending ? (
              <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                Needs Approval
              </span>
            ) : (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${
                  plugin.enabled
                    ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-500"
                }`}
              >
                {plugin.enabled ? "Active" : "Inactive"}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            by {plugin.author} — {plugin.description}
          </p>
        </div>
        <span className="text-gray-400 text-sm">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 space-y-3">
          {plugin.permissions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Permissions:
              </p>
              <div className="flex flex-wrap gap-1">
                {plugin.permissions.map((p) => (
                  <span
                    key={p}
                    className="text-xs font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400"
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
              className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
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
              className="px-3 py-1 text-xs text-red-500 border border-red-300 dark:border-red-700 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              Revoke Permissions
            </button>
          )}

          {plugin.settings.length > 0 ? (
            <PluginSettings pluginId={plugin.id} definitions={plugin.settings} />
          ) : (
            <p className="text-xs text-gray-400">No configurable settings.</p>
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
      <h2 className="text-lg font-semibold mb-3">AI Assistant</h2>

      <div className="space-y-4 max-w-md">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Provider
          </label>
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
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
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  API Key
                  {config?.hasApiKey && (
                    <span className="font-normal text-green-500 ml-2">Saved</span>
                  )}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config?.hasApiKey ? "Enter new key to update" : "Enter API key"}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={currentProvider?.defaultModel ?? ""}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
            </div>

            {currentProvider?.showBaseUrl && (
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Base URL
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={currentProvider?.defaultBaseUrl ?? ""}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
            )}

            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Save
            </button>

            <p className={`text-xs ${isConfigured ? "text-green-500" : "text-gray-400"}`}>
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
      <h2 className="text-lg font-semibold mb-3">Keyboard Shortcuts</h2>
      <div className="space-y-2 max-w-lg">
        {shortcuts.map((s) => (
          <div key={s.id} className="flex items-center justify-between py-1.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">{s.description}</span>
            <div className="flex items-center gap-2">
              <kbd
                className={`px-2 py-0.5 text-xs rounded border ${
                  recordingId === s.id
                    ? "border-blue-400 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 animate-pulse"
                    : "border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                }`}
              >
                {recordingId === s.id ? "Press keys..." : s.currentKey}
              </kbd>
              <button
                onClick={() => setRecordingId(recordingId === s.id ? null : s.id)}
                className="text-xs text-blue-500 hover:text-blue-600"
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
                  className="text-xs text-gray-400 hover:text-gray-600"
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
      <h2 className="text-lg font-semibold mb-3">Storage</h2>
      {storageInfo ? (
        <div className="space-y-2 max-w-md">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-700 dark:text-gray-300">Mode:</span>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
              {storageInfo.mode === "markdown" ? "Markdown Files" : "SQLite"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-700 dark:text-gray-300">Path:</span>
            <span className="text-sm font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
              {storageInfo.path}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            {storageInfo.mode === "markdown"
              ? "Tasks are stored as .md files with YAML frontmatter. Git-friendly and human-readable."
              : "Tasks are stored in a local SQLite database. Fast queries and structured data."}
          </p>
          <p className="text-xs text-gray-400">
            Storage mode is set via the STORAGE_MODE environment variable. Switching modes requires
            restart. Data is not automatically migrated — use Export then Import to transfer.
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-400">Loading storage info...</p>
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
      <h2 className="text-lg font-semibold mb-3">Data</h2>

      <div className="mb-4">
        <h3 className="text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Export</h3>
        <div className="flex gap-3">
          <button
            onClick={() => handleExport("json")}
            disabled={exporting}
            className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Export JSON
          </button>
          <button
            onClick={() => handleExport("csv")}
            disabled={exporting}
            className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            onClick={() => handleExport("markdown")}
            disabled={exporting}
            className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Export Markdown
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Import</h3>

        {importState === "idle" && (
          <div>
            <label className="inline-block px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
              Choose File
              <input
                type="file"
                accept=".json,.txt,.md"
                onChange={handleFileSelect}
                className="hidden"
              />
            </label>
            <span className="ml-2 text-xs text-gray-400">
              Supports Docket JSON, Todoist JSON, and Markdown/text
            </span>
            {importError && <p className="mt-2 text-xs text-red-500">{importError}</p>}
          </div>
        )}

        {importState === "previewing" && importPreview && (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 max-w-md">
            <p className="text-sm font-medium mb-2">
              Import Preview
              <span className="font-normal text-gray-400 ml-2">({importPreview.format})</span>
            </p>
            <div className="space-y-1 text-xs text-gray-600 dark:text-gray-400 mb-3">
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
                  <p key={i} className="text-xs text-yellow-600 dark:text-yellow-400">
                    {w}
                  </p>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleImport}
                className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                Import
              </button>
              <button
                onClick={handleImportReset}
                className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {importState === "importing" && <p className="text-sm text-gray-500">Importing tasks...</p>}

        {importState === "done" && importResult && (
          <div className="border border-green-200 dark:border-green-800 rounded-lg p-4 max-w-md">
            <p className="text-sm text-green-600 dark:text-green-400 font-medium">
              Successfully imported {importResult.imported} task
              {importResult.imported !== 1 ? "s" : ""}
            </p>
            {importResult.errors.length > 0 && (
              <div className="mt-2">
                {importResult.errors.map((e, i) => (
                  <p key={i} className="text-xs text-red-500">
                    {e}
                  </p>
                ))}
              </div>
            )}
            <button
              onClick={handleImportReset}
              className="mt-2 text-xs text-blue-500 hover:text-blue-600"
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
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <h3 className="text-sm font-medium mb-3">
        {isNew ? "Create Custom Theme" : `Edit: ${theme.name}`}
      </h3>

      <div className="flex gap-4 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Base Type
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setType("light")}
              className={`px-3 py-1 text-xs rounded border ${
                type === "light"
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600"
                  : "border-gray-300 dark:border-gray-600 text-gray-500"
              }`}
            >
              Light
            </button>
            <button
              onClick={() => setType("dark")}
              className={`px-3 py-1 text-xs rounded border ${
                type === "dark"
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600"
                  : "border-gray-300 dark:border-gray-600 text-gray-500"
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
            <p className="text-xs font-medium text-gray-500 mb-2">{group}</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {vars.map((v) => (
                <div key={v.key} className="flex items-center gap-2">
                  {isColorVar(v.key) ? (
                    <input
                      type="color"
                      value={variables[v.key] || "#000000"}
                      onChange={(e) => handleVariableChange(v.key, e.target.value)}
                      className="w-8 h-8 rounded border border-gray-300 dark:border-gray-600 cursor-pointer"
                    />
                  ) : (
                    <input
                      type="text"
                      value={variables[v.key] || ""}
                      onChange={(e) => handleVariableChange(v.key, e.target.value)}
                      className="w-20 px-1 py-0.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                    />
                  )}
                  <span className="text-xs text-gray-600 dark:text-gray-400">{v.label}</span>
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
          className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
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
    return <p className="text-xs text-gray-400">Loading settings...</p>;
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
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
        {definition.name}
        {definition.description && (
          <span className="font-normal text-gray-400 ml-1">— {definition.description}</span>
        )}
      </label>
      {definition.type === "text" && (
        <input
          type="text"
          value={String(value ?? "")}
          placeholder={definition.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
      )}
      {definition.type === "number" && (
        <input
          type="number"
          value={Number(value ?? 0)}
          min={definition.min}
          max={definition.max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
      )}
      {definition.type === "boolean" && (
        <button
          onClick={() => onChange(!value)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            value ? "bg-blue-500" : "bg-gray-300 dark:bg-gray-600"
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
          className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
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
