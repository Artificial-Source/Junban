import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Dices, X } from "lucide-react";
import type { Task } from "../../core/types.js";
import { toDateKey } from "../../utils/format-date.js";

/** Build the pool of tasks eligible for the jar: pending + due today or overdue. */
export function buildJarPool(tasks: Task[]): Task[] {
  const today = toDateKey(new Date());
  return tasks.filter(
    (t) =>
      t.status === "pending" &&
      t.dueDate !== null &&
      t.dueDate.split("T")[0] <= today,
  );
}

/** Pick a random task from a pool, optionally excluding the current one. */
export function pickRandom(pool: Task[], excludeId?: string): Task | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const candidates = excludeId ? pool.filter((t) => t.id !== excludeId) : pool;
  if (candidates.length === 0) return pool[0];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

interface TaskJarProps {
  tasks: Task[];
  onSelectTask: (id: string) => void;
}

export function TaskJar({ tasks, onSelectTask }: TaskJarProps) {
  const [open, setOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [displayTitle, setDisplayTitle] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pool = useMemo(() => buildJarPool(tasks), [tasks]);

  const cleanup = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    intervalRef.current = null;
    timeoutRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const runAnimation = useCallback(
    (target: Task) => {
      if (pool.length <= 1) {
        // Skip animation for 0 or 1 tasks
        setSelectedTask(target);
        setDisplayTitle(target.title);
        setSpinning(false);
        return;
      }

      setSpinning(true);
      let elapsed = 0;
      const totalDuration = 1500;
      let currentInterval = 80;

      const tick = () => {
        const random = pool[Math.floor(Math.random() * pool.length)];
        setDisplayTitle(random.title);
        elapsed += currentInterval;

        if (elapsed >= totalDuration) {
          cleanup();
          setDisplayTitle(target.title);
          setSelectedTask(target);
          setSpinning(false);
          return;
        }

        // Slow down over time
        currentInterval = Math.min(80 + (elapsed / totalDuration) * 250, 300);
        intervalRef.current = setTimeout(tick, currentInterval);
      };

      cleanup();
      intervalRef.current = setTimeout(tick, currentInterval);
    },
    [pool, cleanup],
  );

  const handleOpen = useCallback(() => {
    setOpen(true);
    const target = pickRandom(pool);
    if (target) {
      runAnimation(target);
    } else {
      setSelectedTask(null);
      setDisplayTitle("");
      setSpinning(false);
    }
  }, [pool, runAnimation]);

  const handleShakeAgain = useCallback(() => {
    const target = pickRandom(pool, selectedTask?.id);
    if (target) {
      runAnimation(target);
    }
  }, [pool, selectedTask, runAnimation]);

  const handleStartTask = useCallback(() => {
    if (selectedTask) {
      onSelectTask(selectedTask.id);
      setOpen(false);
    }
  }, [selectedTask, onSelectTask]);

  const handleClose = useCallback(() => {
    cleanup();
    setOpen(false);
    setSelectedTask(null);
    setSpinning(false);
  }, [cleanup]);

  return (
    <>
      <button
        onClick={handleOpen}
        className="p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
        aria-label="Pick a random task"
        title="Task Jar - pick a random task"
      >
        <Dices size={20} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-label="Task Jar"
          onClick={handleClose}
        >
          <div
            className="w-full max-w-md mx-4 bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-2">
              <div className="flex items-center gap-2">
                <Dices size={22} className="text-accent" />
                <h2 className="text-lg font-bold text-on-surface">Task Jar</h2>
              </div>
              <button
                onClick={handleClose}
                className="p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="px-5 pb-5 pt-2">
              {pool.length === 0 ? (
                <div className="text-center py-10">
                  <p className="text-on-surface-muted">Nothing due today!</p>
                </div>
              ) : (
                <>
                  <div
                    className={`min-h-[80px] flex items-center justify-center rounded-lg bg-surface-secondary border border-border/60 px-4 py-6 mb-4 transition-all ${
                      spinning ? "animate-pulse" : "animate-pop-in"
                    }`}
                  >
                    <p
                      className={`text-center text-lg font-semibold ${
                        spinning ? "text-on-surface-muted" : "text-on-surface"
                      }`}
                    >
                      {displayTitle || "..."}
                    </p>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={handleShakeAgain}
                      disabled={spinning || pool.length <= 1}
                      className="flex-1 px-4 py-2.5 rounded-lg bg-surface-tertiary text-on-surface font-medium text-sm hover:bg-surface-tertiary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Shake Again
                    </button>
                    <button
                      onClick={handleStartTask}
                      disabled={spinning || !selectedTask}
                      className="flex-1 px-4 py-2.5 rounded-lg bg-accent text-white font-medium text-sm hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Start This Task
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
