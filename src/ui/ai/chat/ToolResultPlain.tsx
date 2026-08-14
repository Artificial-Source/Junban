/**
 * Bounded plain structured text for tool results (no invented rich cards).
 */
import { memo } from "react";
import { formatStructuredPlain, toolMetaFor } from "../tool-meta";
import type { ChatToolResult } from "../message-view";

export const ToolResultPlain = memo(function ToolResultPlain({
  result,
}: {
  result: ChatToolResult;
}) {
  const meta = toolMetaFor(result.tool);
  const Icon = meta.icon;
  const body = formatStructuredPlain(result.data);

  return (
    <div className="rounded-xl border border-border bg-surface shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-secondary/50 border-b border-border/50">
        <div className="w-5 h-5 rounded-md bg-accent-action/10 flex items-center justify-center">
          <Icon size={11} className="text-accent-foreground" aria-hidden="true" />
        </div>
        <span className="text-xs font-medium text-on-surface-secondary">
          {result.tool.replace(/_/g, " ")}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-on-surface-muted">
          {result.outcome}
          {result.truncated ? " · truncated" : ""}
        </span>
      </div>
      <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-words text-on-surface-secondary max-h-64 overflow-auto">
        {body}
      </pre>
    </div>
  );
});
