/**
 * Data — import preview/apply, export download, complete backup/restore.
 * Restore stages a file, then confirms through ConfirmDialog before upload.
 */
import { useCallback, useRef, useState } from "react";
import {
  ApiError,
  applyImport,
  createBackup,
  exportTasks,
  previewImport,
  restoreBackup,
  type TransferFormatDto,
  type TransferPreviewResponse,
} from "../../api/client";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useWorkspace } from "../../context/WorkspaceContext";
import { SettingsStatusBanner } from "./settingsComponents";
import { downloadBlob, primaryButtonClass, secondaryButtonClass } from "./settingsHelpers";

const IMPORT_FORMATS: { value: TransferFormatDto; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "csv", label: "CSV" },
  { value: "markdown", label: "Markdown" },
  { value: "todoist_json", label: "Todoist JSON" },
];

const EXPORT_FORMATS: { value: "json" | "csv" | "markdown"; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "csv", label: "CSV" },
  { value: "markdown", label: "Markdown" },
];

export function DataTab() {
  const { runMutation, showToast, refreshCatalog, enterRestartRequired } = useWorkspace();
  const importInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const [importFormat, setImportFormat] = useState<TransferFormatDto>("json");
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importContent, setImportContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<TransferPreviewResponse | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<{
    kind: "error" | "success" | "info";
    text: string;
  } | null>(null);

  const [exportFormat, setExportFormat] = useState<"json" | "csv" | "markdown">("json");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [stagedRestoreFile, setStagedRestoreFile] = useState<File | null>(null);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [backupMessage, setBackupMessage] = useState<{
    kind: "error" | "success" | "info" | "warning";
    text: string;
  } | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  const handleImportFile = useCallback(async (file: File | null) => {
    setPreview(null);
    setImportMessage(null);
    if (!file) {
      setImportFileName(null);
      setImportContent(null);
      return;
    }
    try {
      const text = await file.text();
      setImportFileName(file.name);
      setImportContent(text);
    } catch {
      setImportFileName(null);
      setImportContent(null);
      setImportMessage({ kind: "error", text: "Could not read the selected file." });
    }
  }, []);

  const handlePreview = useCallback(async () => {
    if (!importContent) {
      setImportMessage({ kind: "error", text: "Choose a file to import first." });
      return;
    }
    setImportBusy(true);
    setImportMessage(null);
    setPreview(null);
    try {
      const result = await previewImport({ format: importFormat, content: importContent });
      setPreview(result);
      setImportMessage({
        kind: "info",
        text: `Preview ready: ${result.drafts.length} task${result.drafts.length === 1 ? "" : "s"}${
          result.warnings.length > 0
            ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`
            : ""
        }.`,
      });
    } catch (error) {
      setImportMessage({
        kind: "error",
        text: error instanceof ApiError ? error.message : "Import preview failed.",
      });
    } finally {
      setImportBusy(false);
    }
  }, [importContent, importFormat]);

  const handleApply = useCallback(async () => {
    if (!importContent || !preview) {
      setImportMessage({ kind: "error", text: "Preview the import before applying." });
      return;
    }
    setImportBusy(true);
    setImportMessage(null);
    try {
      const result = await runMutation(
        (operationId) =>
          applyImport(
            {
              format: preview.format,
              content: importContent,
              fingerprint: preview.content_fingerprint,
            },
            operationId,
          ),
        { successToast: "Import applied", undoLabel: "Import" },
      );
      if (!result) {
        setImportMessage({ kind: "error", text: "Import could not be applied." });
        return;
      }
      setImportMessage({
        kind: "success",
        text: `Imported ${preview.drafts.length} task${preview.drafts.length === 1 ? "" : "s"}.`,
      });
      setPreview(null);
      setImportContent(null);
      setImportFileName(null);
      if (importInputRef.current) importInputRef.current.value = "";
      refreshCatalog();
    } catch (error) {
      setImportMessage({
        kind: "error",
        text: error instanceof ApiError ? error.message : "Import apply failed.",
      });
    } finally {
      setImportBusy(false);
    }
  }, [importContent, preview, runMutation, refreshCatalog]);

  const handleExport = useCallback(async () => {
    setExportBusy(true);
    setExportMessage(null);
    try {
      const artifact = await exportTasks({ format: exportFormat });
      downloadBlob(artifact);
      showToast("success", "Export downloaded");
    } catch (error) {
      setExportMessage(error instanceof ApiError ? error.message : "Export failed.");
    } finally {
      setExportBusy(false);
    }
  }, [exportFormat, showToast]);

  const handleBackup = useCallback(async () => {
    setBackupBusy(true);
    setBackupMessage(null);
    try {
      const artifact = await createBackup();
      downloadBlob(artifact);
      setBackupMessage({ kind: "success", text: "Backup downloaded." });
      showToast("success", "Backup downloaded");
    } catch (error) {
      setBackupMessage({
        kind: "error",
        text: error instanceof ApiError ? error.message : "Backup failed.",
      });
    } finally {
      setBackupBusy(false);
    }
  }, [showToast]);

  const stageRestoreFile = useCallback((file: File | null) => {
    if (!file) return;
    setStagedRestoreFile(file);
    setConfirmRestoreOpen(true);
    setBackupMessage(null);
  }, []);

  const cancelRestore = useCallback(() => {
    if (restoreBusy) return;
    setConfirmRestoreOpen(false);
    setStagedRestoreFile(null);
    if (restoreInputRef.current) restoreInputRef.current.value = "";
  }, [restoreBusy]);

  const confirmRestore = useCallback(async () => {
    if (!stagedRestoreFile || restoreBusy) return;
    setRestoreBusy(true);
    setBackupMessage(null);
    setRestartRequired(false);
    try {
      const result = await restoreBackup(stagedRestoreFile);
      setConfirmRestoreOpen(false);
      setStagedRestoreFile(null);
      // Successful cutover is always restart_required; do not resume normal work.
      // Suppress SSE terminal/retry banners only after the restore response confirms it.
      if (result.restart_required) {
        enterRestartRequired();
      }
      setRestartRequired(true);
      setBackupMessage({
        kind: "warning",
        text: result.restart_required
          ? "Restore cutover completed. The service is stopped until you restart the server."
          : "Restore finished. Restart the server before continuing.",
      });
      showToast("info", "Restart required after restore");
    } catch (error) {
      setBackupMessage({
        kind: "error",
        text: error instanceof ApiError ? error.message : "Restore failed.",
      });
      setConfirmRestoreOpen(false);
      setStagedRestoreFile(null);
    } finally {
      setRestoreBusy(false);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  }, [stagedRestoreFile, restoreBusy, showToast, enterRestartRequired]);

  return (
    <div className="space-y-8">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-on-surface">Data</h2>
        <p className="mt-1 text-sm text-on-surface-muted">
          Import, export, and complete profile backup.
        </p>
      </div>

      <section className="space-y-4">
        <h3 className="text-base font-semibold text-on-surface">Import</h3>
        <label className="block max-w-md space-y-1.5">
          <span className="text-sm text-on-surface">Format</span>
          <select
            value={importFormat}
            onChange={(event) => {
              setImportFormat(event.target.value as TransferFormatDto);
              setPreview(null);
            }}
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface"
          >
            {IMPORT_FORMATS.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block max-w-md space-y-1.5">
          <span className="text-sm text-on-surface">File</span>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,.csv,.md,.markdown,.txt,application/json,text/csv,text/markdown,text/plain"
            onChange={(event) => void handleImportFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-on-surface file:mr-3 file:rounded-md file:border-0 file:bg-surface-tertiary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-on-surface"
          />
          <span className="text-xs text-on-surface-muted">
            {importFileName ? `Selected: ${importFileName}` : "Choose a transfer file"}
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!importContent || importBusy}
            onClick={() => void handlePreview()}
            className={secondaryButtonClass(!importContent || importBusy)}
          >
            {importBusy && !preview ? "Previewing…" : "Preview"}
          </button>
          <button
            type="button"
            disabled={!preview || importBusy}
            onClick={() => void handleApply()}
            className={primaryButtonClass(!preview || importBusy)}
          >
            {importBusy && preview ? "Applying…" : "Apply import"}
          </button>
        </div>
        {importMessage && (
          <SettingsStatusBanner kind={importMessage.kind}>
            {importMessage.text}
          </SettingsStatusBanner>
        )}
        {preview && (
          <div className="space-y-2 rounded-lg border border-border bg-surface-secondary p-3 text-sm">
            <p className="font-medium text-on-surface">
              {preview.drafts.length} task{preview.drafts.length === 1 ? "" : "s"} ready
            </p>
            {preview.warnings.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-on-surface-secondary">
                {preview.warnings.slice(0, 12).map((warning, index) => (
                  <li key={`${warning.line}-${index}`}>
                    Line {warning.line}: {warning.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-base font-semibold text-on-surface">Export</h3>
        <label className="block max-w-md space-y-1.5">
          <span className="text-sm text-on-surface">Format</span>
          <select
            value={exportFormat}
            onChange={(event) => setExportFormat(event.target.value as "json" | "csv" | "markdown")}
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface"
          >
            {EXPORT_FORMATS.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={exportBusy}
          onClick={() => void handleExport()}
          className={primaryButtonClass(exportBusy)}
        >
          {exportBusy ? "Exporting…" : "Export"}
        </button>
        {exportMessage && <SettingsStatusBanner kind="error">{exportMessage}</SettingsStatusBanner>}
      </section>

      <section className="space-y-4">
        <h3 className="text-base font-semibold text-on-surface">Backup</h3>
        <p className="max-w-lg text-sm text-on-surface-muted">
          Complete profile backup excludes access tokens and diagnostics.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={backupBusy || restoreBusy}
            onClick={() => void handleBackup()}
            className={primaryButtonClass(backupBusy || restoreBusy)}
          >
            {backupBusy ? "Creating backup…" : "Create backup"}
          </button>
          <button
            type="button"
            disabled={backupBusy || restoreBusy}
            onClick={() => restoreInputRef.current?.click()}
            className={secondaryButtonClass(backupBusy || restoreBusy)}
          >
            Restore backup…
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            aria-label="Backup file to restore"
            accept=".junban-backup,application/octet-stream"
            className="sr-only"
            onChange={(event) => stageRestoreFile(event.target.files?.[0] ?? null)}
          />
        </div>
        {backupMessage && (
          <SettingsStatusBanner kind={backupMessage.kind}>
            {backupMessage.text}
          </SettingsStatusBanner>
        )}
        {restartRequired && (
          <SettingsStatusBanner kind="warning">
            Restart required. Stop and start the Junban server, then reconnect with your access
            token. Do not continue editing until the restart finishes.
          </SettingsStatusBanner>
        )}
      </section>

      <ConfirmDialog
        open={confirmRestoreOpen}
        title="Restore complete backup?"
        message={
          stagedRestoreFile
            ? `Restore from “${stagedRestoreFile.name}”? Cutover stops the service, replaces the live profile, and requires a server restart before you can continue.`
            : "Restore this backup? Cutover stops the service and requires a server restart."
        }
        confirmLabel="Restore backup"
        cancelLabel="Cancel"
        danger
        pending={restoreBusy}
        onConfirm={() => void confirmRestore()}
        onCancel={cancelRestore}
      />
    </div>
  );
}
