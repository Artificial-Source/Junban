import { useState, useEffect, useCallback } from "react";
import { Zap } from "lucide-react";
import { useGeneralSettings } from "../../../context/SettingsContext.js";
import { SettingRow, Toggle } from "../components.js";
import { isTauri } from "../../../../utils/tauri.js";

/** Validate that a hotkey string contains at least one modifier key. */
function isValidHotkey(hotkey: string): boolean {
  const lower = hotkey.toLowerCase();
  return (
    lower.includes("ctrl") ||
    lower.includes("cmd") ||
    lower.includes("alt") ||
    lower.includes("shift") ||
    lower.includes("super") ||
    lower.includes("cmdorctrl")
  );
}

/** Format a keyboard event into a Tauri shortcut string (e.g. "CmdOrCtrl+Shift+Space"). */
function keyEventToShortcut(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Ignore standalone modifier keys
  const ignoredKeys = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);
  if (ignoredKeys.has(e.key)) return null;

  // Map special key names
  const keyMap: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };

  const key = keyMap[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);

  return parts.join("+");
}

export function QuickCaptureSettings() {
  const { settings, updateSetting } = useGeneralSettings();
  const enabled = settings.quick_capture_enabled === "true";
  const [recording, setRecording] = useState(false);
  const [recordedHotkey, setRecordedHotkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRecord = useCallback(() => {
    setRecording(true);
    setRecordedHotkey(null);
    setError(null);
  }, []);

  const handleReset = useCallback(() => {
    updateSetting("quick_capture_hotkey", "CmdOrCtrl+Shift+Space");
    setError(null);
  }, [updateSetting]);

  // Listen for key events while recording
  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const shortcut = keyEventToShortcut(e);
      if (!shortcut) return; // Still pressing modifiers only

      if (!isValidHotkey(shortcut)) {
        setError("Shortcut must include a modifier key (Ctrl, Cmd, Alt, or Shift)");
        setRecording(false);
        return;
      }

      setRecordedHotkey(shortcut);
      updateSetting("quick_capture_hotkey", shortcut);
      setRecording(false);
      setError(null);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [recording, updateSetting]);

  // Cancel recording on Escape via separate listener
  useEffect(() => {
    if (!recording) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setRecording(false);
      }
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [recording]);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 text-on-surface flex items-center gap-2">
        <Zap className="w-5 h-5" />
        Quick Capture
      </h2>
      <p className="text-xs text-on-surface-muted mb-4">
        System-wide shortcut to capture tasks from anywhere. Available only in the desktop app.
      </p>
      <div className="space-y-4 max-w-md">
        <SettingRow
          label="Enable quick capture"
          description="Register a global hotkey to show the capture window"
        >
          <Toggle
            enabled={enabled}
            onToggle={() => updateSetting("quick_capture_enabled", enabled ? "false" : "true")}
          />
        </SettingRow>

        <div className={enabled ? "" : "opacity-50 pointer-events-none"}>
          <SettingRow label="Hotkey" description={error ?? "Press Record to set a new shortcut"}>
            <div className="flex items-center gap-2">
              <kbd className="px-2.5 py-1 text-xs font-mono bg-surface-tertiary border border-border rounded-md text-on-surface min-w-[120px] text-center">
                {recording ? "Press keys..." : (recordedHotkey ?? settings.quick_capture_hotkey)}
              </kbd>
              <button
                onClick={recording ? () => setRecording(false) : handleRecord}
                className="px-3 py-1 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
              >
                {recording ? "Cancel" : "Record"}
              </button>
              <button
                onClick={handleReset}
                className="px-3 py-1 text-xs font-medium rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors"
              >
                Reset
              </button>
            </div>
          </SettingRow>
        </div>
      </div>
    </section>
  );
}

/** Renders QuickCaptureSettings only in Tauri environment. */
export function StartupSection() {
  if (!isTauri()) return null;
  return <QuickCaptureSettings />;
}
