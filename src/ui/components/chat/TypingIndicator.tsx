import { Bot } from "lucide-react";
import { memo } from "react";

interface TypingIndicatorProps {
  mode?: "panel" | "view";
}

export const TypingIndicator = memo(function TypingIndicator({ mode = "panel" }: TypingIndicatorProps) {
  const isView = mode === "view";
  const avatarSize = isView ? 28 : 24;
  const iconSize = isView ? 14 : 12;

  return (
    <div className="flex items-start gap-2">
      <div
        className="shrink-0 rounded-full bg-accent/10 text-accent flex items-center justify-center animate-pulse"
        style={{ width: avatarSize, height: avatarSize }}
      >
        <Bot size={iconSize} />
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-tertiary">
        <div className="typing-shimmer w-20 h-1 rounded-full" />
      </div>
    </div>
  );
});
