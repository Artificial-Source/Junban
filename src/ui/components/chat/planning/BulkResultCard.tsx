import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { PRIORITY_COLORS, PRIORITY_LABELS } from "../ChatTaskResults";

export function BulkResultCard({
  data,
  toolName,
  onSelectTask,
}: {
  data: Record<string, unknown>;
  toolName: string;
  onSelectTask?: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const items = (data.created ?? data.completed ?? data.updated ?? []) as {
    id?: string;
    title?: string;
    status?: string;
    priority?: number;
  }[];
  const count = (data.count as number) ?? items.length;

  if (items.length === 0) return null;

  const verb =
    toolName === "bulk_create_tasks"
      ? "Created"
      : toolName === "bulk_complete_tasks"
        ? "Completed"
        : "Updated";

  const visibleItems = expanded ? items : items.slice(0, 5);
  const hasMore = items.length > 5;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {verb} {count} task{count !== 1 ? "s" : ""}
        </button>
      </div>
      <div className="space-y-px">
        {visibleItems.map((item, i) => (
          <button
            key={item.id ?? i}
            onClick={() => item.id && onSelectTask?.(item.id)}
            className="w-full text-left px-2.5 py-2 rounded-lg text-xs hover:bg-surface-secondary/80 transition-colors flex items-center gap-2 group/row"
          >
            {toolName === "bulk_complete_tasks" ? (
              <CheckCircle2 size={14} className="text-success shrink-0" />
            ) : (
              <span className="w-3.5 h-3.5 rounded-full border-2 border-accent/30 shrink-0 flex items-center justify-center">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              </span>
            )}
            <span className="flex-1 min-w-0 truncate text-on-surface">{item.title}</span>
            {item.priority && item.priority >= 1 && item.priority <= 4 && (
              <span
                className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[item.priority]}`}
              >
                {PRIORITY_LABELS[item.priority]}
              </span>
            )}
          </button>
        ))}
        {hasMore && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-accent hover:text-accent-hover px-2.5 py-1.5 font-medium"
          >
            +{items.length - 5} more
          </button>
        )}
      </div>
    </div>
  );
}
