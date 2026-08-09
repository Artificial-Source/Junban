/**
 * Microphone selection — permission only after an explicit button press.
 * Stores only the selected device ID in versioned non-secret localStorage.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { AlertCircle, CheckCircle2, Mic, RefreshCw } from "lucide-react";
import {
  enumerateMicrophones,
  readMicPreferences,
  requestMicrophoneAccessAndEnumerate,
  writeMicPreferences,
  type MicrophoneDevice,
} from "../../../voice/micPreferences";

export type MicrophoneSelectorProps = {
  /** Optional external selected id override (tests / fixtures). */
  selectedId?: string;
  onSelectedIdChange?: (deviceId: string) => void;
  disabled?: boolean;
};

export function MicrophoneSelector({
  selectedId: controlledId,
  onSelectedIdChange,
  disabled = false,
}: MicrophoneSelectorProps = {}) {
  const selectId = useId();
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [selectedId, setSelectedId] = useState(() => controlledId ?? readMicPreferences().deviceId);
  const [loading, setLoading] = useState(false);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied" | "unsupported">(
    "unknown",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (controlledId !== undefined) setSelectedId(controlledId);
  }, [controlledId]);

  const applySelection = useCallback(
    (deviceId: string) => {
      setSelectedId(deviceId);
      writeMicPreferences({ version: 1, deviceId });
      onSelectedIdChange?.(deviceId);
    },
    [onSelectedIdChange],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await enumerateMicrophones();
      setDevices(list);
      setPermission(list.length > 0 || permission === "granted" ? "granted" : permission);
      if (selectedId && list.length > 0 && !list.some((item) => item.deviceId === selectedId)) {
        applySelection("");
      }
    } catch {
      setError("Could not list microphones.");
    } finally {
      setLoading(false);
    }
  }, [applySelection, permission, selectedId]);

  const handleRequestPermission = async () => {
    setLoading(true);
    setError(null);
    const result = await requestMicrophoneAccessAndEnumerate();
    switch (result.status) {
      case "granted":
        setPermission("granted");
        setDevices(result.devices);
        break;
      case "denied":
        setPermission("denied");
        setDevices([]);
        break;
      case "unsupported":
        setPermission("unsupported");
        setError("Microphone access is not supported in this browser.");
        break;
      case "failed":
        setError("Could not access the microphone.");
        break;
    }
    setLoading(false);
  };

  return (
    <fieldset className="space-y-3" data-testid="microphone-selector" disabled={disabled}>
      <legend className="mb-2 text-sm font-semibold text-on-surface">Microphone</legend>

      <p className="text-xs text-on-surface-muted">
        Browser recognition uses the system default device until you grant access and pick one.
        Device labels stay in this browser only.
      </p>

      {permission !== "granted" && !loading && (
        <div className="space-y-3">
          {permission === "denied" ? (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Microphone access was denied. Use your browser site settings to allow the
                microphone, then try again.
              </span>
            </p>
          ) : (
            <p className="text-xs text-on-surface-muted">
              Grant microphone access to choose an input device.
            </p>
          )}
          <button
            type="button"
            disabled={disabled || loading || permission === "unsupported"}
            onClick={() => void handleRequestPermission()}
            className="flex items-center gap-2 rounded-lg bg-on-surface px-3 py-2 text-sm text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Mic size={14} aria-hidden="true" />
            Allow microphone access
          </button>
        </div>
      )}

      {loading && (
        <div role="status" className="flex items-center gap-2 text-xs text-on-surface-muted">
          <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
          Detecting microphones…
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-error">
          <AlertCircle size={12} aria-hidden="true" />
          {error}
        </p>
      )}

      {permission === "granted" && (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-success">
              <CheckCircle2 size={12} aria-hidden="true" />
              {devices.length} microphone{devices.length !== 1 ? "s" : ""} detected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={selectId} className="sr-only">
              Microphone
            </label>
            <select
              id={selectId}
              value={selectedId}
              disabled={disabled || loading}
              onChange={(event) => applySelection(event.target.value)}
              className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            >
              <option value="">System default</option>
              {devices.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={disabled || loading}
              aria-label="Refresh microphones"
              title="Refresh microphones"
              className="shrink-0 rounded-lg p-2 text-on-surface-muted transition-colors hover:bg-surface-secondary hover:text-on-surface disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}
