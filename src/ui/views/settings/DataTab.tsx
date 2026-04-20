import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Globe, Loader2 } from "lucide-react";
import { useTaskContext } from "../../context/TaskContext.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";
import { api } from "../../api/index.js";
import {
  DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT,
  type DesktopRemoteServerConfig,
  type DesktopRemoteServerStatus,
} from "../../api/desktop-server.js";
import { exportJSON, exportCSV, exportMarkdown, type ExportData } from "../../../core/export.js";
import { parseImport, type ImportPreview } from "../../../core/import.js";
import { SegmentedControl } from "./components.js";
import type { Project, Task } from "../../../core/types.js";
import { isTauri } from "../../../utils/tauri.js";

interface DataTabProps {
  mutationsBlocked?: boolean;
}

export function DataTab({ mutationsBlocked = false }: DataTabProps) {
  // Use the authoritative combined lock state: mutationsBlocked OR readOnly from context
  const { readOnly } = useGeneralSettings();
  const isLocked = mutationsBlocked || readOnly;

  return (
    <>
      <RemoteAccessSection />
      <StorageSection />
      <DataSection isLocked={isLocked} />
    </>
  );
}

function RemoteAccessSection() {
  const [status, setStatus] = useState<DesktopRemoteServerStatus>({
    available: false,
    running: false,
    port: null,
    localUrl: null,
  });
  const [config, setConfig] = useState<DesktopRemoteServerConfig>({
    port: 4822,
    autoStart: false,
    passwordEnabled: false,
    hasPassword: false,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const handleStatusChange = (event: Event) => {
      setStatus((event as CustomEvent<DesktopRemoteServerStatus>).detail);
    };

    window.addEventListener(
      DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT,
      handleStatusChange as EventListener,
    );

    void Promise.all([api.getDesktopRemoteServerStatus(), api.getDesktopRemoteServerConfig()])
      .then(([nextStatus, nextConfig]) => {
        setStatus(nextStatus);
        setConfig(nextConfig);
      })
      .catch((err: unknown) => {
        console.error("[settings:data] Failed to load remote server settings:", err);
        setError("Could not load remote access settings.");
      });

    return () => {
      window.removeEventListener(
        DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT,
        handleStatusChange as EventListener,
      );
    };
  }, []);

  if (!isTauri()) {
    return null;
  }

  const parsedPort = Number.parseInt(String(config.port), 10);
  const portIsValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const passwordRequired =
    config.passwordEnabled && !config.hasPassword && password.trim().length === 0;

  const saveConfig = async () => {
    if (!portIsValid) {
      setError("Choose a port between 1 and 65535.");
      return null;
    }

    if (passwordRequired) {
      setError("Enter a password before enabling password protection.");
      return null;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const nextConfig = await api.updateDesktopRemoteServerConfig({
        port: parsedPort,
        autoStart: config.autoStart,
        passwordEnabled: config.passwordEnabled,
        password: password.trim() ? password : undefined,
      });
      setConfig(nextConfig);
      setPassword("");
      setMessage(
        status.running
          ? "Saved. Restart remote access to apply protection or port changes."
          : "Remote access settings saved.",
      );
      return nextConfig;
    } catch (err) {
      console.error("[settings:data] Failed to save remote access config:", err);
      setError("Could not save remote access settings.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    const nextConfig = await saveConfig();
    if (!nextConfig) {
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      setStatus(await api.startDesktopRemoteServer(nextConfig.port));
      setMessage(
        "Remote access is running. Use the local URL or your Tailscale IP with this port.",
      );
    } catch (err) {
      console.error("[settings:data] Failed to start remote server:", err);
      setError(err instanceof Error ? err.message : "Could not start remote access.");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      setStatus(await api.stopDesktopRemoteServer());
      setMessage("Remote access stopped.");
    } catch (err) {
      console.error("[settings:data] Failed to stop remote server:", err);
      setError("Could not stop remote access.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <Globe size={18} className="text-accent" />
        <h2 className="text-lg font-semibold text-on-surface">Remote Access</h2>
      </div>
      <div className="space-y-4 max-w-2xl rounded-xl border border-border bg-surface-secondary/40 p-4">
        <p className="text-sm text-on-surface-secondary">
          Host Junban from the desktop app so you can open it from another device over your network
          or Tailscale.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[140px]">
            <span className="mb-1 block text-sm text-on-surface-secondary">Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={config.port}
              onChange={(e) =>
                setConfig((current) => ({ ...current, port: Number(e.target.value) }))
              }
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
            <input
              type="checkbox"
              checked={config.autoStart}
              onChange={(e) =>
                setConfig((current) => ({ ...current, autoStart: e.target.checked }))
              }
            />
            Start automatically when the app opens
          </label>
        </div>

        <div className="space-y-3 rounded-lg border border-border/70 bg-surface/60 p-3">
          <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
            <input
              type="checkbox"
              checked={config.passwordEnabled}
              onChange={(e) =>
                setConfig((current) => ({ ...current, passwordEnabled: e.target.checked }))
              }
            />
            Protect remote access with a password
          </label>

          {config.passwordEnabled && (
            <label className="block max-w-sm">
              <span className="mb-1 block text-sm text-on-surface-secondary">
                {config.hasPassword ? "Change password" : "Set password"}
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  config.hasPassword ? "Leave blank to keep current password" : "Enter password"
                }
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
              />
            </label>
          )}

          <button
            type="button"
            onClick={() => {
              void saveConfig();
            }}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-on-surface hover:bg-surface-tertiary disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : null}
            Save access settings
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            onClick={status.running ? handleStop : handleStart}
            disabled={loading || !portIsValid}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${
              status.running
                ? "border border-border bg-surface text-on-surface hover:bg-surface-tertiary"
                : "bg-accent text-white hover:bg-accent-hover"
            }`}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Globe size={16} />}
            {status.running ? "Stop remote access" : "Start remote access"}
          </button>
        </div>

        {!portIsValid && <p className="text-xs text-error">Choose a port between 1 and 65535.</p>}
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" aria-live="polite" className="text-xs text-success">
            {message}
          </p>
        )}

        <div
          className="space-y-1 text-sm text-on-surface-secondary"
          role="status"
          aria-live="polite"
        >
          <p>
            Status:{" "}
            <span className={status.running ? "text-success" : "text-on-surface"}>
              {status.running ? "Running" : "Stopped"}
            </span>
          </p>
          {status.localUrl && (
            <p>
              Host-only URL: <span className="font-mono text-on-surface">{status.localUrl}</span>
              <span className="block text-xs text-on-surface-muted mt-0.5">
                For remote devices, use your LAN or Tailscale IP with port {status.port}
              </span>
            </p>
          )}
          <p className="text-xs text-on-surface-muted">
            When remote access is running, local desktop changes that write data are paused,
            including quick capture and import. These remote-access controls stay available here.
          </p>
          <p className="text-xs text-on-surface-muted">
            For Tailscale, start the server here and then open your Tailscale device IP with this
            port from the other machine.
          </p>
          <p className="text-xs text-on-surface-muted">
            Password protection is optional. If enabled, the first remote browser enters it once and
            then keeps a local session cookie.
          </p>
        </div>
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
      .catch((err: unknown) => console.error("[settings:data] Failed to load storage info:", err));
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

interface DataSectionProps {
  isLocked: boolean;
}

function DataSection({ isLocked }: DataSectionProps) {
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
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const importBlockedMessage =
    "Import is unavailable while remote access is running. Stop remote access from the desktop app to change local data.";

  // Export filter state
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "completed">("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    if (showFilters) {
      api
        .listProjects()
        .then(setProjects)
        .catch((err: unknown) => console.error("[settings:data] Failed to load projects:", err));
    }
  }, [showFilters]);

  const handleExport = async (format: "json" | "csv" | "markdown") => {
    setExporting(true);
    try {
      const data = await api.exportAllData();

      // Apply filters
      let filteredTasks = data.tasks;
      if (statusFilter !== "all") {
        filteredTasks = filteredTasks.filter((t: Task) => t.status === statusFilter);
      }
      if (projectFilter !== "all") {
        if (projectFilter === "none") {
          filteredTasks = filteredTasks.filter((t: Task) => !t.projectId);
        } else {
          filteredTasks = filteredTasks.filter((t: Task) => t.projectId === projectFilter);
        }
      }

      const filteredData = { ...data, tasks: filteredTasks };

      let content: string;
      let filename: string;
      let mimeType: string;

      if (format === "json") {
        const exportData: ExportData = {
          ...filteredData,
          exportedAt: new Date().toISOString(),
          version: "1.0",
        };
        content = exportJSON(exportData);
        filename = `junban-export-${new Date().toISOString().split("T")[0]}.json`;
        mimeType = "application/json";
      } else if (format === "csv") {
        content = exportCSV(filteredTasks);
        filename = `junban-tasks-${new Date().toISOString().split("T")[0]}.csv`;
        mimeType = "text/csv";
      } else {
        content = exportMarkdown(filteredTasks);
        filename = `junban-tasks-${new Date().toISOString().split("T")[0]}.md`;
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
    if (isLocked) {
      setImportError(importBlockedMessage);
      e.target.value = "";
      return;
    }

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

    if (isLocked) {
      setImportError(importBlockedMessage);
      return;
    }

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
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-medium text-on-surface-secondary">Export</h3>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover"
          >
            Filters
            {showFilters ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>

        {showFilters && (
          <div className="mb-3 p-3 border border-border rounded-lg bg-surface-secondary space-y-3 max-w-md">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-on-surface-secondary">Status</span>
              <SegmentedControl
                options={[
                  { value: "all" as const, label: "All" },
                  { value: "pending" as const, label: "Pending" },
                  { value: "completed" as const, label: "Completed" },
                ]}
                value={statusFilter}
                onChange={setStatusFilter}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-on-surface-secondary">Project</span>
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="px-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface"
              >
                <option value="all">All projects</option>
                <option value="none">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

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
        {isLocked && (
          <p
            id="data-import-locked-note"
            role="status"
            aria-live="polite"
            className="mb-2 text-xs text-warning"
          >
            {importBlockedMessage}
          </p>
        )}

        {importState === "idle" && (
          <div>
            <button
              type="button"
              onClick={() => importFileInputRef.current?.click()}
              disabled={isLocked}
              aria-describedby={isLocked ? "data-import-locked-note" : undefined}
              className="inline-block px-4 py-2 text-sm border border-border rounded-lg hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Choose File
            </button>
            <input
              ref={importFileInputRef}
              type="file"
              accept=".json,.txt,.md"
              onChange={handleFileSelect}
              disabled={isLocked}
              className="hidden"
            />
            <span className="ml-2 text-xs text-on-surface-muted">
              Supports Junban JSON, Todoist JSON, and Markdown/text
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
                type="button"
                onClick={handleImport}
                disabled={isLocked}
                aria-describedby={isLocked ? "data-import-locked-note" : undefined}
                className="px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Import
              </button>
              <button
                type="button"
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
              type="button"
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
