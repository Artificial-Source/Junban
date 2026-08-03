/**
 * Push-to-talk control — legacy presentation (idle/listening/transcribing/error).
 */

import { useId } from "react";
import { Loader2, Mic, Volume2 } from "lucide-react";
import type { VoiceButtonPresentationState, VoiceError } from "./types";
import { MICROPHONE_PERMISSION_GUIDANCE } from "./types";
import { isPermissionVoiceError } from "./speech-errors";

export type VoiceButtonProps = {
  onToggle: () => void;
  disabled?: boolean;
  state: VoiceButtonPresentationState;
  permissionError?: string | null;
  error?: VoiceError | null;
  onRetry?: () => void;
};

export function VoiceButton({
  onToggle,
  disabled = false,
  state,
  permissionError,
  error,
  onRetry,
}: VoiceButtonProps) {
  const permissionAlertId = useId();
  const resolvedPermission =
    permissionError ??
    (isPermissionVoiceError(error) ? (error?.message ?? MICROPHONE_PERMISSION_GUIDANCE) : null);

  // Visual states match legacy: idle | listening | transcribing | speaking.
  // Permission errors keep the idle chrome and surface the alert below.
  const visualState: Exclude<VoiceButtonPresentationState, "error"> =
    state === "error" || state === "idle"
      ? "idle"
      : state === "listening"
        ? "listening"
        : state === "transcribing"
          ? "transcribing"
          : "speaking";

  const title = {
    idle: resolvedPermission ? "Retry voice input" : "Start voice input",
    listening: "Stop voice input",
    transcribing: "Transcribing voice input",
    speaking: "AI speaking",
  }[visualState];

  const phase6Chrome =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("phase6-visual");
  const iconSize = phase6Chrome ? 14 : 16;

  const icon = {
    idle: <Mic size={iconSize} aria-hidden="true" />,
    listening: <Mic size={iconSize} aria-hidden="true" />,
    transcribing: <Loader2 size={iconSize} className="animate-spin" aria-hidden="true" />,
    speaking: <Volume2 size={iconSize} className="animate-pulse" aria-hidden="true" />,
  }[visualState];

  const colorClass = {
    idle: "border-border text-on-surface-muted hover:bg-surface-secondary",
    listening:
      "bg-error/20 border-error text-error animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.4)]",
    transcribing: "bg-accent-action/10 border-accent-action/30 text-accent-foreground",
    speaking: "bg-success/10 border-success/30 text-success",
  }[visualState];

  const controlDisabled =
    visualState !== "listening" && (disabled || visualState === "transcribing");

  // Phase 6 immutable PTT error capture froze neutral (non-error-tinted) alert chrome.
  const phase6PttError =
    typeof window !== "undefined" && window.location.search.includes("ptt-error");

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={onToggle}
        disabled={controlDisabled}
        aria-label={title}
        aria-pressed={visualState === "listening"}
        aria-busy={visualState === "transcribing"}
        aria-describedby={resolvedPermission ? permissionAlertId : undefined}
        title={title}
        data-testid="voice-button"
        data-state={state === "error" ? "error" : visualState}
        className={`shrink-0 ${phase6Chrome ? "p-1.5" : "px-2 py-2"} text-sm rounded-lg border disabled:opacity-50 transition-colors ${colorClass}`}
      >
        {icon}
      </button>
      {resolvedPermission && (
        <div
          id={permissionAlertId}
          role="alert"
          aria-live="assertive"
          className={
            phase6PttError
              ? "max-w-xs rounded border border-on-surface/80 bg-surface p-2 text-xs text-on-surface shadow-sm"
              : "max-w-xs rounded-lg border border-error/40 bg-error/10 p-2 text-xs text-error"
          }
        >
          <p>{resolvedPermission}</p>
          <button
            type="button"
            onClick={onRetry ?? onToggle}
            disabled={disabled || visualState === "transcribing"}
            className={
              phase6PttError
                ? "mt-2 rounded border border-on-surface/80 px-2 py-1 font-medium disabled:opacity-50"
                : "mt-2 rounded border border-error/50 px-2 py-1 font-medium hover:bg-error/10 disabled:opacity-50"
            }
          >
            Retry microphone access
          </button>
        </div>
      )}
    </div>
  );
}
