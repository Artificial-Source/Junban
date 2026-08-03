import { memo } from "react";
import { toolBadgeLabel, toolMetaFor } from "../tool-meta";

export const ToolCallBadge = memo(function ToolCallBadge({
  name,
  args,
  isComplete,
}: {
  name: string;
  args: unknown;
  isComplete?: boolean;
}) {
  const meta = toolMetaFor(name);
  const label = toolBadgeLabel(name, args);
  const Icon = meta.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-colors ${
        isComplete
          ? "bg-surface-secondary border-border text-on-surface-secondary"
          : "bg-accent-action/10 border-accent-action/30 text-accent-foreground"
      }`}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
});
