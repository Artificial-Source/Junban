/**
 * Wave 4a lazy AI chat route entry.
 * Renders only the not-configured shell — no provider, voice, or network runtime.
 */
import { AIChatNotConfigured } from "./AIChatNotConfigured";

export interface AIChatRouteProps {
  onOpenSettings: () => void;
}

export function AIChatRoute({ onOpenSettings }: AIChatRouteProps) {
  return (
    <div className="flex h-full min-h-[20rem] w-full flex-1 flex-col">
      <AIChatNotConfigured
        isView
        onClose={() => {
          /* View mode has no close control; panel mode owns dismissal later. */
        }}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
