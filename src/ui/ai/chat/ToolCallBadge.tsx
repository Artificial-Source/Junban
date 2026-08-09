import { memo } from "react";
import { isPhase6VisualFixture } from "../../lib/phase6VisualFixture";
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
  // Immutable capture froze completed badges as tight secondary chips (less rounding).
  const phase6 = isPhase6VisualFixture();

  return (
    <span
      className={`inline-flex items-center text-xs transition-colors ${
        phase6
          ? "gap-0.5 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-on-surface-secondary border-r border-border last:border-r-0"
          : `gap-1.5 px-2.5 py-1 rounded-full border ${
              isComplete
                ? "bg-surface-secondary border-border text-on-surface-secondary"
                : "bg-accent-action/10 border-accent-action/30 text-accent-foreground"
            }`
      }`}
    >
      <Icon size={phase6 ? 10 : 12} aria-hidden="true" />
      {label}
    </span>
  );
});
