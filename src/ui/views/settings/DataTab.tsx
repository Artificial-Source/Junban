import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTaskContext } from "../../context/TaskContext.js";
import { api } from "../../api/index.js";
import { exportJSON, exportCSV, exportMarkdown, type ExportData } from "../../../core/export.js";
import { parseImport, type ImportPreview } from "../../../core/import.js";
import { SegmentedControl } from "./components.js";
import type { Project, Task } from "../../../core/types.js";

export function DataTab() {
  return (
    <>
      <StorageSection />
      <DataSection />
    </>
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
        filename = `saydo-export-${new Date().toISOString().split("T")[0]}.json`;
        mimeType = "application/json";
      } else if (format === "csv") {
        content = exportCSV(filteredTasks);
        filename = `saydo-tasks-${new Date().toISOString().split("T")[0]}.csv`;
        mimeType = "text/csv";
      } else {
        content = exportMarkdown(filteredTasks);
        filename = `saydo-tasks-${new Date().toISOString().split("T")[0]}.md`;
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
              Supports Saydo JSON, Todoist JSON, and Markdown/text
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
