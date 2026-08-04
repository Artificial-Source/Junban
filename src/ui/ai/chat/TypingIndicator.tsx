import { Bot } from "lucide-react";
import { memo } from "react";

export const TypingIndicator = memo(function TypingIndicator({
  mode = "view",
  status,
}: {
  mode?: "panel" | "view";
  /** Optional short reasoning status (never hidden CoT). */
  status?: string | null;
}) {
  const isView = mode === "view";
  const avatarSize = isView ? 28 : 24;
  const iconSize = isView ? 14 : 12;
  const label = status?.trim() ? status.trim() : "AI is preparing a response.";

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex items-start gap-2">
      <span className="sr-only">{label}</span>
      <div
        aria-hidden="true"
        className="shrink-0 rounded-full bg-accent-action/10 text-accent-foreground flex items-center justify-center motion-safe:animate-pulse"
        style={{ width: avatarSize, height: avatarSize }}
      >
        <Bot size={iconSize} />
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-surface-tertiary"
      >
        {status?.trim() ? (
          <span className="text-xs text-on-surface-muted">{status.trim()}</span>
        ) : (
          <div className="typing-shimmer w-20 h-1 rounded-full" />
        )}
      </div>
    </div>
  );
});
