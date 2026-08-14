/**
 * Diagnostics — bounded server diagnostic ring with severity filter and clear.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  clearDiagnostics,
  getDiagnostics,
  type DiagnosticEntry,
  type DiagnosticSeverity,
} from "../../api/client";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useWorkspace } from "../../context/WorkspaceContext";
import { SettingsStatusBanner } from "./settingsComponents";
import { secondaryButtonClass } from "./settingsHelpers";

type SeverityFilter = "all" | DiagnosticSeverity;

const FILTERS: { value: SeverityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
];

function severityClass(severity: DiagnosticSeverity): string {
  switch (severity) {
    case "error":
      return "text-error";
    case "warning":
      return "text-on-surface";
    default:
      return "text-on-surface-secondary";
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function DiagnosticsTab() {
  const { showToast } = useWorkspace();
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SeverityFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getDiagnostics();
      setEntries(response.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load diagnostics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((entry) => entry.severity === filter);
  }, [entries, filter]);

  const handleClearConfirm = useCallback(async () => {
    if (clearing) return;
    setClearing(true);
    setError(null);
    try {
      await clearDiagnostics();
      showToast("success", "Diagnostics cleared");
      setConfirmClearOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not clear diagnostics.");
      setConfirmClearOpen(false);
    } finally {
      setClearing(false);
    }
  }, [clearing, load, showToast]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold text-on-surface">Diagnostics</h2>
          <p className="mt-1 text-sm text-on-surface-muted">
            Recent redacted server diagnostic entries.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading || clearing}
            onClick={() => void load()}
            className={secondaryButtonClass(loading || clearing)}
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={loading || clearing || entries.length === 0}
            onClick={() => setConfirmClearOpen(true)}
            className={secondaryButtonClass(loading || clearing || entries.length === 0)}
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
        </div>
      </div>

      {error && <SettingsStatusBanner kind="error">{error}</SettingsStatusBanner>}

      <SegmentedControl
        label="Severity filter"
        options={FILTERS}
        value={filter}
        onChange={setFilter}
      />

      {loading ? (
        <p className="text-sm text-on-surface-muted">Loading diagnostics…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          {entries.length === 0 ? "No diagnostic entries." : "No entries match this filter."}
        </p>
      ) : (
        <ul
          className="max-h-[28rem] space-y-2 overflow-y-auto rounded-lg border border-border p-2"
          aria-label="Diagnostic entries"
        >
          {filtered.map((entry, index) => (
            <li
              key={`${entry.timestamp}-${entry.code}-${index}`}
              className="rounded-md border border-border/70 bg-surface-secondary px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={`text-xs font-semibold tracking-wide uppercase ${severityClass(entry.severity)}`}
                >
                  {entry.severity}
                </span>
                <span className="font-mono text-xs text-on-surface">{entry.code}</span>
                <span className="text-xs text-on-surface-muted">
                  {formatTimestamp(entry.timestamp)}
                </span>
                {entry.request_id && (
                  <span className="font-mono text-[11px] text-on-surface-muted">
                    req {entry.request_id}
                  </span>
                )}
              </div>
              <p className="mt-1 text-on-surface-secondary">{entry.message}</p>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear diagnostics?"
        message="Clear all diagnostic entries? This cannot be undone."
        confirmLabel="Clear diagnostics"
        cancelLabel="Cancel"
        danger
        pending={clearing}
        onConfirm={() => void handleClearConfirm()}
        onCancel={() => {
          if (!clearing) setConfirmClearOpen(false);
        }}
      />
    </div>
  );
}
