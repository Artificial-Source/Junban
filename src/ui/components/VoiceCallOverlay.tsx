/**
 * In-call UI overlay shown in the AIChatPanel input area during a voice call.
 * Displays call state indicator, duration timer, and end call button.
 */

import { PhoneOff } from "lucide-react";
import type { CallState } from "../hooks/useVoiceCall.js";

interface VoiceCallOverlayProps {
  callState: Exclude<CallState, "idle">;
  callDuration: number;
  onEndCall: () => void;
  isInGracePeriod?: boolean;
  gracePeriodProgress?: number;
}

const STATE_CONFIG: Record<
  VoiceCallOverlayProps["callState"],
  { label: string; color: string; ringColor: string }
> = {
  greeting: { label: "Starting...", color: "bg-accent", ringColor: "ring-accent/30" },
  listening: { label: "Listening...", color: "bg-success", ringColor: "ring-success/30" },
  processing: { label: "Thinking...", color: "bg-accent", ringColor: "ring-accent/30" },
  speaking: { label: "Speaking...", color: "bg-info", ringColor: "ring-info/30" },
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VoiceCallOverlay({
  callState,
  callDuration,
  onEndCall,
  isInGracePeriod,
  gracePeriodProgress,
}: VoiceCallOverlayProps) {
  const { label, color, ringColor } = STATE_CONFIG[callState];
  const displayLabel = isInGracePeriod ? "Waiting..." : label;

  return (
    <div className="flex flex-col items-center gap-3 py-4" data-testid="voice-call-overlay">
      {/* Pulsing indicator */}
      <div className="relative flex items-center justify-center">
        <span
          className={`absolute w-12 h-12 rounded-full ring-4 ${ringColor} animate-ping opacity-30`}
          data-testid="pulse-ring"
        />
        <span
          className={`relative w-8 h-8 rounded-full ${color} animate-pulse`}
          data-testid="state-dot"
        />
      </div>

      {/* Grace period progress */}
      {isInGracePeriod && gracePeriodProgress !== undefined && (
        <div className="w-24 h-1 bg-surface-tertiary rounded-full overflow-hidden">
          <div
            className="h-full bg-warning rounded-full transition-all duration-100"
            style={{ width: `${gracePeriodProgress * 100}%` }}
          />
        </div>
      )}

      {/* Timer and state label */}
      <div className="text-center">
        <p className="text-lg font-mono text-on-surface" data-testid="call-duration">
          {formatDuration(callDuration)}
        </p>
        <p className="text-xs text-on-surface-muted" data-testid="call-state-label">
          {displayLabel}
        </p>
      </div>

      {/* End Call button */}
      <button
        onClick={onEndCall}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-error text-white rounded-full hover:bg-error/90 transition-colors"
        aria-label="End call"
        data-testid="end-call-button"
      >
        <PhoneOff size={16} />
        End Call
      </button>
    </div>
  );
}
