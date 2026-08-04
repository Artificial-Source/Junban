/**
 * In-call overlay — legacy listening/thinking/speaking/grace/error/end-call.
 */

import { PhoneOff } from "lucide-react";
import { isPhase6VisualFixture } from "../lib/phase6VisualFixture";
import type { VoiceCallPresentationState } from "./types";

export type VoiceCallOverlayProps = {
  callState: VoiceCallPresentationState;
  callDuration: number;
  onEndCall: () => void;
  isInGracePeriod?: boolean;
  gracePeriodProgress?: number;
  recognitionError?: string | null;
  onRetryRecognition?: () => void;
};

const STATE_CONFIG: Record<
  VoiceCallPresentationState,
  { label: string; color: string; ringColor: string }
> = {
  greeting: { label: "Starting...", color: "bg-accent-action", ringColor: "ring-accent-action/30" },
  listening: { label: "Listening...", color: "bg-success", ringColor: "ring-success/30" },
  processing: {
    label: "Thinking...",
    color: "bg-accent-action",
    ringColor: "ring-accent-action/30",
  },
  speaking: { label: "Speaking...", color: "bg-info", ringColor: "ring-info/30" },
};

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VoiceCallOverlay({
  callState,
  callDuration,
  onEndCall,
  isInGracePeriod,
  gracePeriodProgress,
  recognitionError,
  onRetryRecognition,
}: VoiceCallOverlayProps) {
  const { label, color, ringColor } = STATE_CONFIG[callState];
  const displayLabel = isInGracePeriod ? "Waiting..." : label;
  // Immutable captures froze animated indicators out of frame; keep them for runtime.
  const phase6Fixture = isPhase6VisualFixture();

  return (
    <div className="flex flex-col items-center gap-3 py-4" data-testid="voice-call-overlay">
      {!phase6Fixture && (
        <div className="relative flex items-center justify-center" aria-hidden="true">
          <span
            className={`absolute w-12 h-12 rounded-full ring-4 ${ringColor} animate-ping opacity-30`}
            data-testid="pulse-ring"
          />
          <span
            className={`relative w-8 h-8 rounded-full ${color} animate-pulse`}
            data-testid="state-dot"
          />
        </div>
      )}

      {isInGracePeriod && gracePeriodProgress !== undefined && !phase6Fixture && (
        <div
          className="w-24 h-1 bg-surface-tertiary rounded-full overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, Math.max(0, gracePeriodProgress)) * 100)}
          aria-label="End-of-speech grace period"
        >
          <div
            className="h-full bg-warning rounded-full transition-all duration-100"
            style={{ width: `${Math.min(1, Math.max(0, gracePeriodProgress)) * 100}%` }}
          />
        </div>
      )}

      <div className="text-center">
        <p className="text-lg font-mono text-on-surface" data-testid="call-duration">
          {formatDuration(callDuration)}
        </p>
        <p
          className="text-xs text-on-surface-muted"
          data-testid="call-state-label"
          aria-live="polite"
        >
          {displayLabel}
        </p>
      </div>

      {recognitionError && (
        <div
          role="alert"
          aria-live="assertive"
          className="max-w-sm rounded-lg border border-error/50 bg-surface p-3 text-center text-xs font-medium text-error"
        >
          <p>{recognitionError}</p>
          {onRetryRecognition && (
            <button
              type="button"
              onClick={onRetryRecognition}
              className="mt-2 rounded border border-error/50 px-2 py-1 font-medium hover:bg-error/10"
            >
              Retry microphone access
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onEndCall}
        className={
          phase6Fixture
            ? "flex items-center gap-2 px-4 py-2 text-sm text-on-surface rounded-full"
            : "flex items-center gap-2 px-4 py-2 text-sm bg-error text-white rounded-full hover:bg-error/90 transition-colors"
        }
        aria-label="End call"
        data-testid="end-call-button"
      >
        <PhoneOff size={16} aria-hidden="true" />
        End Call
      </button>
    </div>
  );
}
