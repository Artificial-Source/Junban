/**
 * Keyboard — search/list/edit presentation with accessible two-key recording.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { formatShortcutBinding } from "../../hooks/useKeyboardShortcuts";
import {
  mergeShortcutRows,
  rebindShortcut,
  recordShortcutKeydown,
  recordShortcutTimeout,
  resetShortcutToDefault,
  TWO_KEY_CHORD_TIMEOUT_MS,
} from "./keyboardShortcuts";
import { SettingsStatusBanner } from "./settingsComponents";
import { useSettingsSave } from "./useSettingsSave";

export function KeyboardTab() {
  const { settings, settingsLoading, settingsError, refreshSettings, savePatch, savingKey, error } =
    useSettingsSave();
  const [searchQuery, setSearchQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const pendingFirstRef = useRef<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ action: string; message: string } | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rows = useMemo(
    () => mergeShortcutRows(settings?.keyboard_shortcuts),
    [settings?.keyboard_shortcuts],
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter(
      (row) =>
        row.description.toLowerCase().includes(q) ||
        row.chord.toLowerCase().includes(q) ||
        row.action.toLowerCase().includes(q),
    );
  }, [rows, searchQuery]);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    clearPendingTimer();
    pendingFirstRef.current = null;
    setRecordingId(null);
    setPendingPrompt(null);
  }, [clearPendingTimer]);

  useEffect(() => {
    pendingFirstRef.current = null;
    clearPendingTimer();
    setPendingPrompt(null);
    if (!recordingId) return;
    setRowError(null);

    const commitChord = (chord: string, action: string) => {
      const current = rows.map((row) => ({ action: row.action, chord: row.chord }));
      const result = rebindShortcut(current, action, chord);
      if (!result.ok || !result.next) {
        setRowError({
          action,
          message: result.ok ? "Could not update shortcut." : result.message,
        });
        stopRecording();
        return;
      }

      stopRecording();
      void savePatch(`keyboard:${action}`, { keyboard_shortcuts: result.next }).then((ok) => {
        if (!ok) {
          setRowError({
            action,
            message: "Could not save shortcut.",
          });
        }
      });
    };

    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const recorded = recordShortcutKeydown(event, pendingFirstRef.current);
      if (recorded.kind === "ignore") return;
      if (recorded.kind === "cancel") {
        stopRecording();
        return;
      }
      if (recorded.kind === "pending") {
        pendingFirstRef.current = recorded.first;
        setPendingPrompt(recorded.prompt);
        clearPendingTimer();
        pendingTimerRef.current = setTimeout(() => {
          const timedOut = recordShortcutTimeout();
          if (timedOut.kind === "timeout") {
            setRowError({
              action: recordingId,
              message: timedOut.message,
            });
          }
          stopRecording();
        }, TWO_KEY_CHORD_TIMEOUT_MS);
        return;
      }
      if (recorded.kind === "chord") {
        clearPendingTimer();
        commitChord(recorded.chord, recordingId);
      }
    };

    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      clearPendingTimer();
    };
  }, [clearPendingTimer, recordingId, rows, savePatch, stopRecording]);

  if (settingsLoading && !settings) {
    return <p className="text-sm text-on-surface-muted">Loading settings…</p>;
  }
  if (!settings) {
    return (
      <SettingsStatusBanner kind="error">
        {settingsError ?? "Settings are unavailable."}{" "}
        <button type="button" className="underline" onClick={() => void refreshSettings()}>
          Retry
        </button>
      </SettingsStatusBanner>
    );
  }

  const busy = savingKey !== null;

  const handleReset = (action: string) => {
    const current = rows.map((row) => ({ action: row.action, chord: row.chord }));
    const result = resetShortcutToDefault(current, action);
    if (!result.ok || !result.next) {
      setRowError({
        action,
        message: result.ok ? "Could not reset shortcut." : result.message,
      });
      return;
    }
    setRowError(null);
    void savePatch(`keyboard-reset:${action}`, { keyboard_shortcuts: result.next });
  };

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold text-on-surface">Keyboard Shortcuts</h2>
      <p className="mb-3 max-w-lg text-sm text-on-surface-muted">
        Edit one-stroke modifier bindings or two-key chords. Changes apply only after the server
        confirms them.
      </p>

      {(error || rowError) && (
        <div className="mb-3">
          <SettingsStatusBanner kind="error">{rowError?.message ?? error}</SettingsStatusBanner>
        </div>
      )}

      <div className="relative mb-3 max-w-lg">
        <Search
          size={16}
          className="absolute top-1/2 left-3 -translate-y-1/2 text-on-surface-muted"
          aria-hidden="true"
        />
        <input
          type="search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="w-full rounded-lg border border-border bg-surface py-2 pr-3 pl-9 text-sm text-on-surface placeholder-on-surface-muted focus:ring-2 focus:ring-focus focus:outline-none"
        />
      </div>

      <div className="max-w-lg space-y-2">
        {filtered.length === 0 ? (
          <p className="py-4 text-sm text-on-surface-muted">No shortcuts match your search.</p>
        ) : (
          filtered.map((row) => {
            const isRecording = recordingId === row.action;
            const isRowSaving =
              savingKey === `keyboard:${row.action}` ||
              savingKey === `keyboard-reset:${row.action}`;
            const prompt =
              isRecording && pendingPrompt
                ? pendingPrompt
                : isRecording
                  ? "Press keys…"
                  : formatShortcutBinding(row.chord);
            return (
              <div key={row.action}>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-sm text-on-surface-secondary">{row.description}</span>
                  <div className="flex items-center gap-2">
                    <kbd
                      className={`rounded border px-2 py-0.5 text-xs ${
                        isRecording
                          ? "animate-pulse border-accent-action bg-accent-action/10 text-accent-foreground"
                          : "border-border bg-surface-secondary text-on-surface-secondary"
                      }`}
                      aria-live={isRecording ? "polite" : undefined}
                    >
                      {prompt}
                    </kbd>
                    <button
                      type="button"
                      aria-pressed={isRecording}
                      disabled={busy && !isRecording}
                      onClick={() => {
                        if (isRecording) {
                          stopRecording();
                          return;
                        }
                        setRowError(null);
                        pendingFirstRef.current = null;
                        setPendingPrompt(null);
                        setRecordingId(row.action);
                      }}
                      className="rounded px-1 text-xs font-medium text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface disabled:opacity-50"
                    >
                      {isRecording ? "Cancel" : isRowSaving ? "Saving…" : "Edit"}
                    </button>
                    {row.chord !== row.defaultChord && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleReset(row.action)}
                        className="text-xs text-on-surface-muted hover:text-on-surface-secondary disabled:opacity-50"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
                {rowError?.action === row.action && rowError.message && (
                  <p role="alert" className="mt-0.5 mb-1 text-xs text-warning">
                    {rowError.message}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
