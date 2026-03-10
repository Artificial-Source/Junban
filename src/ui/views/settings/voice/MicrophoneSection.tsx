import { useState, useEffect, useCallback } from "react";
import { Mic, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  enumerateMicrophones,
  triggerMicPermissionPrompt,
  type MicrophoneInfo,
} from "../../../../ai/voice/audio-utils.js";
import type { VoiceSettings } from "../../../../ui/context/VoiceContext.js";

export function MicrophoneSection({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (patch: Partial<VoiceSettings>) => void;
}) {
  const [microphones, setMicrophones] = useState<MicrophoneInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionState, setPermissionState] = useState<PermissionState | null>(null);
  const [promptTimedOut, setPromptTimedOut] = useState(false);

  // Enumerate devices (no permission request — assumes permission already granted)
  const refreshMicrophones = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mics = await enumerateMicrophones();
      setMicrophones(mics);
      setPermissionGranted(mics.length > 0);
    } catch {
      setError("Could not access microphones.");
      setPermissionGranted(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Check and watch permission state (without prompting)
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions) return;

    const handleChange = (status: PermissionStatus) => {
      setPermissionState(status.state);
      if (status.state === "granted") {
        refreshMicrophones();
      }
    };

    let permStatus: PermissionStatus | null = null;
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        permStatus = status;
        setPermissionState(status.state);
        if (status.state === "granted") {
          refreshMicrophones();
        }
        status.addEventListener("change", () => handleChange(status));
      })
      .catch(() => {
        // permissions.query not supported for microphone in some browsers
      });

    return () => {
      if (permStatus) {
        permStatus.onchange = null;
      }
    };
  }, [refreshMicrophones]);

  // Listen for device changes (plug/unplug) — only when already granted
  useEffect(() => {
    if (!permissionGranted) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    const handler = () => refreshMicrophones();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [permissionGranted, refreshMicrophones]);

  // Reset selected mic if it's no longer available
  useEffect(() => {
    if (
      selectedId &&
      microphones.length > 0 &&
      !microphones.some((m) => m.deviceId === selectedId)
    ) {
      onSelect({ microphoneId: "" });
    }
  }, [selectedId, microphones, onSelect]);

  const handleRequestPermission = async () => {
    setLoading(true);
    setError(null);
    setPromptTimedOut(false);

    // Fire getUserMedia to trigger the browser permission dialog.
    // This may hang on some systems (e.g. Linux + PipeWire) even after the user
    // clicks Allow, so we use a timeout. The Permissions API change listener
    // above will detect the grant independently and enumerate devices.
    const ok = await triggerMicPermissionPrompt(8000);

    if (ok) {
      // getUserMedia resolved — permission granted and device opened successfully
      await refreshMicrophones();
    } else {
      // Timed out or failed. Check if permission was actually granted
      // (browser dialog might have worked but getUserMedia hung on device open).
      try {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (status.state === "granted") {
          // Permission was granted but getUserMedia hung — enumerate directly
          await refreshMicrophones();
        } else {
          setPromptTimedOut(true);
          setLoading(false);
        }
      } catch {
        setPromptTimedOut(true);
        setLoading(false);
      }
    }
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-on-surface mb-2">Microphone</legend>

      {!permissionGranted && !loading && !error && (
        <div className="space-y-3">
          {promptTimedOut ? (
            <div className="p-3 rounded-lg border border-warning/30 bg-warning/5 space-y-2">
              <p className="text-xs text-on-surface">
                The browser permission dialog didn't respond. This can happen on Linux with
                PipeWire/PulseAudio.
              </p>
              <p className="text-xs text-on-surface-muted">
                Try granting microphone access directly: click the lock/site icon in your browser's
                address bar, find "Microphone", and set it to "Allow". The page will detect the
                change automatically.
              </p>
              <button
                type="button"
                onClick={handleRequestPermission}
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
              >
                <Mic size={14} />
                Try again
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-on-surface-muted">
                Grant microphone access to enable voice input.
              </p>
              <button
                type="button"
                onClick={handleRequestPermission}
                className="flex items-center gap-2 px-3 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
              >
                <Mic size={14} />
                Allow microphone access
              </button>
            </>
          )}
          {permissionState === "denied" && (
            <p className="text-xs text-warning flex items-start gap-1.5">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span>
                Microphone access was denied. Click the lock/site icon in your browser's address bar
                to reset the permission, then try again.
              </span>
            </p>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-on-surface-muted">
          <RefreshCw size={12} className="animate-spin" />
          Detecting microphones...
        </div>
      )}

      {error && (
        <div className="space-y-2">
          <span className="text-xs text-error flex items-center gap-1.5">
            <AlertCircle size={12} />
            {error}
          </span>
          <button
            type="button"
            onClick={refreshMicrophones}
            className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {permissionGranted && (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-success flex items-center gap-1.5">
              <CheckCircle2 size={12} />
              {microphones.length} microphone{microphones.length !== 1 ? "s" : ""} detected
            </span>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={selectedId}
              onChange={(e) => onSelect({ microphoneId: e.target.value })}
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            >
              <option value="">System default</option>
              {microphones.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={refreshMicrophones}
              disabled={loading}
              title="Refresh microphones"
              className="shrink-0 p-2 text-on-surface-muted hover:text-on-surface rounded-lg hover:bg-surface-secondary transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}
