import { useState, useEffect, useCallback, useMemo } from "react";
import { AlertCircle, ArrowRight, X, Calendar } from "lucide-react";
import type { TimeBlock } from "../types.js";
import type { TimeBlockStore } from "../store.js";
import { formatDateStr } from "./TimelineColumn.js";

interface ReplanBannerProps {
  store: TimeBlockStore;
  taskStatuses?: Map<string, "pending" | "completed" | "cancelled">;
  onReplanComplete: () => void;
}

interface StaleBlock {
  block: TimeBlock;
  taskPending: boolean;
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDateStr(d);
}

function formatBlockDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function ReplanBanner({ store, taskStatuses, onReplanComplete }: ReplanBannerProps) {
  const [staleBlocks, setStaleBlocks] = useState<StaleBlock[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const todayStr = useMemo(() => formatDateStr(new Date()), []);

  // Check for stale blocks on mount
  useEffect(() => {
    const pastBlocks: StaleBlock[] = [];

    // Look at blocks from the past 7 days (not including today)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const rangeStart = formatDateStr(sevenDaysAgo);

    const yesterdayStr = yesterday();
    const blocks = store.listBlocksInRange(rangeStart, yesterdayStr);

    for (const block of blocks) {
      // Only include blocks with linked tasks that are still pending
      if (block.taskId) {
        const status = taskStatuses?.get(block.taskId);
        if (status === "pending" || status === undefined) {
          pastBlocks.push({ block, taskPending: true });
        }
      } else {
        // Non-task blocks from the past are also stale
        pastBlocks.push({ block, taskPending: false });
      }
    }

    setStaleBlocks(pastBlocks);
  }, [store, taskStatuses, todayStr]);

  const handleReplanToday = useCallback(
    async (block: TimeBlock) => {
      await store.updateBlock(block.id, { date: todayStr });
      setStaleBlocks((prev) => prev.filter((s) => s.block.id !== block.id));
    },
    [store, todayStr],
  );

  const handleReplanTomorrow = useCallback(
    async (block: TimeBlock) => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      await store.updateBlock(block.id, { date: formatDateStr(tomorrow) });
      setStaleBlocks((prev) => prev.filter((s) => s.block.id !== block.id));
    },
    [store],
  );

  const handleSkip = useCallback(
    async (block: TimeBlock) => {
      await store.deleteBlock(block.id);
      setStaleBlocks((prev) => prev.filter((s) => s.block.id !== block.id));
    },
    [store],
  );

  const handleReplanAllToday = useCallback(async () => {
    for (const { block } of staleBlocks) {
      await store.updateBlock(block.id, { date: todayStr });
    }
    setStaleBlocks([]);
    setShowModal(false);
    onReplanComplete();
  }, [store, staleBlocks, todayStr, onReplanComplete]);

  // Auto-close modal when all blocks handled
  useEffect(() => {
    if (showModal && staleBlocks.length === 0) {
      setShowModal(false);
      onReplanComplete();
    }
  }, [staleBlocks.length, showModal, onReplanComplete]);

  if (staleBlocks.length === 0 || dismissed) return null;

  return (
    <>
      {/* Banner */}
      <div
        className="flex items-center gap-3 px-4 py-2 bg-warning/10 border-b border-warning/30"
        data-testid="replan-banner"
      >
        <AlertCircle size={16} className="text-warning flex-shrink-0" />
        <span className="text-sm text-on-surface flex-1">
          You have <strong>{staleBlocks.length}</strong> incomplete{" "}
          {staleBlocks.length === 1 ? "block" : "blocks"} from the past.
        </span>
        <button
          onClick={() => setShowModal(true)}
          className="px-3 py-1 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
          data-testid="replan-open-btn"
        >
          Replan
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="p-1 rounded hover:bg-surface-secondary text-on-surface-muted transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div
            className="bg-surface border border-border rounded-lg shadow-xl w-[480px] max-h-[80vh] flex flex-col"
            data-testid="replan-modal"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-on-surface">Replan Incomplete Blocks</h3>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 rounded hover:bg-surface-secondary text-on-surface-muted"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {staleBlocks.map(({ block }) => (
                <div
                  key={block.id}
                  className="flex items-center gap-3 p-3 rounded-md border border-border bg-surface-secondary"
                  data-testid={`replan-item-${block.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-on-surface truncate">{block.title}</div>
                    <div className="flex items-center gap-2 text-xs text-on-surface-muted mt-0.5">
                      <Calendar size={10} />
                      <span>{formatBlockDate(block.date)}</span>
                      <span>·</span>
                      <span>{block.startTime} – {block.endTime}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleReplanToday(block)}
                      className="px-2 py-1 text-xs rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                      data-testid={`replan-today-${block.id}`}
                    >
                      Today
                    </button>
                    <button
                      onClick={() => handleReplanTomorrow(block)}
                      className="px-2 py-1 text-xs rounded-md bg-surface-tertiary text-on-surface-secondary hover:bg-surface-tertiary/80 transition-colors"
                    >
                      Tomorrow
                    </button>
                    <button
                      onClick={() => handleSkip(block)}
                      className="px-2 py-1 text-xs rounded-md text-error hover:bg-error/10 transition-colors"
                    >
                      Skip
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="px-4 py-3 border-t border-border flex justify-between">
              <button
                onClick={() => setShowModal(false)}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-on-surface-secondary hover:bg-surface-secondary transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleReplanAllToday}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
                data-testid="replan-all-today"
              >
                <ArrowRight size={14} />
                Replan All to Today
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
