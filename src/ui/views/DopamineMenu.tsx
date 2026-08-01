/**
 * Motivation / Quick Wins view.
 * Consumes Rust dopamine-menu, eat-the-frog, and task-jar reads.
 * Task jar selection is server-deterministic for the sampled civil date.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Dices, Zap } from "lucide-react";
import {
  ApiError,
  getDopamineMenu,
  getEatTheFrog,
  getTaskJar,
  getTemporalSettings,
  type TaskDto,
  type TemporalSettingsResponse,
} from "../api/client";
import { TaskList } from "../components/TaskList";
import { ViewSkeleton } from "../components/Skeleton";
import { useToday } from "../hooks/useToday";

interface DopamineMenuProps {
  onToggleTask: (id: string) => Promise<boolean>;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    orderedIds: string[],
  ) => void;
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
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
}: DopamineMenuProps) {
  const today = useToday();
  const [quickWins, setQuickWins] = useState<TaskDto[]>([]);
  const [frogTask, setFrogTask] = useState<TaskDto | null>(null);
  const [jarTask, setJarTask] = useState<TaskDto | null>(null);
  const [settings, setSettings] = useState<TemporalSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [frogEaten, setFrogEaten] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [menu, frog, jar, temporal] = await Promise.all([
        getDopamineMenu(),
        getEatTheFrog(),
        getTaskJar(),
        getTemporalSettings(),
      ]);
      // Prefer server task order (task_ids) when provided.
      const byId = new Map(menu.tasks.map((t) => [t.id, t]));
      const ordered =
        menu.task_ids.length > 0
          ? menu.task_ids.map((id) => byId.get(id)).filter((t): t is TaskDto => !!t)
          : menu.tasks;
      setQuickWins(ordered);
      setFrogTask(frog.task ?? null);
      // Server returns a deterministic ordered list for the civil day; first entry is the pick.
      const jarById = new Map(jar.tasks.map((t) => [t.id, t]));
      const jarOrdered =
        jar.task_ids.length > 0
          ? jar.task_ids.map((id) => jarById.get(id)).filter((t): t is TaskDto => !!t)
          : jar.tasks;
      setJarTask(jarOrdered[0] ?? null);
      setSettings(temporal);
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught.message);
      else setError("Could not load motivation tools.");
      setQuickWins([]);
      setFrogTask(null);
      setJarTask(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, today]);

  const handleToggle = useCallback(
    async (id: string): Promise<boolean> => {
      if (pendingId) return false;
      const task = quickWins.find((t) => t.id === id) ?? (frogTask?.id === id ? frogTask : null);
      setPendingId(id);
      setActionError(null);
      try {
        const ok = await onToggleTask(id);
        if (!ok) {
          setActionError("The task could not be updated.");
          return false;
        }
        if (task?.status === "pending") {
          setShowConfetti(true);
          if (frogTask?.id === id) setFrogEaten(true);
        }
        void load();
        return true;
      } catch {
        setActionError("The task could not be updated.");
        return false;
      } finally {
        setPendingId(null);
      }
    },
    [pendingId, quickWins, frogTask, onToggleTask, load],
  );

  if (loading && quickWins.length === 0 && !frogTask && !jarTask) {
    return <ViewSkeleton />;
  }

  const showFrog = settings?.eat_the_frog_enabled && frogTask;
  const showJar = settings?.task_jar_enabled && jarTask;

  return (
    <div aria-busy={pendingId !== null || undefined}>
      <div className="mb-4 flex items-center gap-3 md:mb-6">
        <Zap size={28} className="text-amber-400" />
        <div>
          <h1 className="text-2xl font-bold text-on-surface md:text-3xl">Quick Wins</h1>
          <p className="text-sm text-on-surface-muted">Need a quick win? Pick one!</p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
        >
          {error}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
        >
          {actionError}
        </div>
      )}

      {showFrog && (
        <div className="mb-4">
          {frogEaten ? (
            <div className="animate-fade-in rounded-lg border border-success/30 bg-success/5 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/15">
                  <Check size={20} className="text-success" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-success">Frog eaten!</p>
                  <p className="text-xs text-on-surface-muted">
                    Great job tackling your most dreaded task first.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div
              className="animate-fade-in cursor-pointer rounded-lg border border-border bg-surface-secondary p-4 transition-colors hover:bg-surface-tertiary"
              onClick={() => onSelectTask(frogTask.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectTask(frogTask.id);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`Eat the frog: ${frogTask.title}`}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-warning/15 text-lg">
                  🐸
                </div>
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                    Eat this frog first!
                  </p>
                  <p className="truncate text-sm font-semibold text-on-surface">{frogTask.title}</p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleToggle(frogTask.id);
                  }}
                  disabled={pendingId === frogTask.id}
                  className="flex-shrink-0 rounded-md bg-success/10 px-3 py-1.5 text-xs font-medium text-success transition-colors hover:bg-success/20 disabled:opacity-60"
                  aria-label="Complete frog task"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showJar && (
        <div className="mb-4 rounded-lg border border-border bg-surface-secondary p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent-action/10">
              <Dices size={20} className="text-accent-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="mb-0.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                Task Jar · {today}
              </p>
              <p
                className="truncate text-sm font-semibold text-on-surface"
                data-testid="task-jar-selection"
              >
                {jarTask.title}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onSelectTask(jarTask.id)}
              className="flex-shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface"
            >
              Open
            </button>
          </div>
        </div>
      )}

      {quickWins.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-lg text-on-surface-muted">
            No quick wins right now. You&apos;re tackling the hard stuff!
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
          todayKey={today}
        />
      )}

      {showConfetti && <ConfettiOverlay onDone={() => setShowConfetti(false)} />}
    </div>
  );
}
