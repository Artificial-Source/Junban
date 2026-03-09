import { useState, useMemo, useCallback, useEffect } from "react";
import { Zap } from "lucide-react";
import { TaskList } from "../components/TaskList.js";
import type { Task } from "../../core/types.js";

/** Filter criteria for "quick win" tasks: pending + any of the easy-task signals. */
export function filterQuickWins(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) =>
      t.status === "pending" &&
      ((t.estimatedMinutes !== null && t.estimatedMinutes <= 15) ||
        (t.priority !== null && t.priority >= 3)),
  );
}

/** Sort quick wins: shortest estimated time first, nulls last. */
export function sortQuickWins(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aMin = a.estimatedMinutes;
    const bMin = b.estimatedMinutes;
    if (aMin === null && bMin === null) return 0;
    if (aMin === null) return 1;
    if (bMin === null) return -1;
    return aMin - bMin;
  });
}

interface DopamineMenuProps {
  tasks: Task[];
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  onReorder?: (orderedIds: string[]) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
  onContextMenu?: (taskId: string, position: { x: number; y: number }) => void;
}

const CONFETTI_COLORS = [
  "#6366f1",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
  "#f97316",
];

function ConfettiOverlay({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 1800);
    return () => clearTimeout(timer);
  }, [onDone]);

  const [particles] = useState(() =>
    Array.from({ length: 24 }, (_, i) => ({
      id: i,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      left: `${10 + ((i * 37 + 13) % 80)}%`,
      delay: `${((i * 13) % 300) / 1000}s`,
      size: 4 + ((i * 7) % 6),
    })),
  );

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="absolute animate-confetti-burst rounded-full"
          style={{
            left: p.left,
            bottom: "40%",
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            animationDelay: p.delay,
          }}
        />
      ))}
    </div>
  );
}

export function DopamineMenu({
  tasks,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onReorder,
  onAddSubtask,
  onUpdateDueDate,
  onContextMenu,
}: DopamineMenuProps) {
  const [showConfetti, setShowConfetti] = useState(false);
  const [, setCompletedIds] = useState<Set<string>>(new Set());

  const quickWins = useMemo(() => sortQuickWins(filterQuickWins(tasks)), [tasks]);

  const handleToggle = useCallback(
    (id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (task && task.status === "pending") {
        setShowConfetti(true);
        setCompletedIds((prev) => new Set([...prev, id]));
      }
      onToggleTask(id);
    },
    [tasks, onToggleTask],
  );

  const dismissConfetti = useCallback(() => setShowConfetti(false), []);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <Zap size={28} className="text-amber-400" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-on-surface">Quick Wins</h1>
          <p className="text-sm text-on-surface-muted">Need a quick win? Pick one!</p>
        </div>
      </div>

      {quickWins.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-lg text-on-surface-muted">
            No quick wins right now. You're tackling the hard stuff!
          </p>
        </div>
      ) : (
        <TaskList
          tasks={quickWins}
          onToggle={handleToggle}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
          emptyMessage="No quick wins right now. You're tackling the hard stuff!"
          selectedTaskIds={selectedTaskIds}
          onMultiSelect={onMultiSelect}
          onReorder={onReorder}
          onAddSubtask={onAddSubtask}
          onUpdateDueDate={onUpdateDueDate}
          onContextMenu={onContextMenu}
        />
      )}

      {showConfetti && <ConfettiOverlay onDone={dismissConfetti} />}
    </div>
  );
}
