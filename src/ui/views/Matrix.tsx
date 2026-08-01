/**
 * Eisenhower Matrix with native pointer drag and keyboard-equivalent moves.
 * One awaited task PATCH applies each quadrant change using the list response's
 * server-local civil date.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import type { TaskDto } from "../api/client";
import { useViewTasks } from "../hooks/useViewTasks";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { ViewSkeleton } from "../components/Skeleton";
import {
  MATRIX_QUADRANTS,
  classifyMatrixTask,
  groupMatrixTasks,
  matrixDropPatch,
  type MatrixQuadrant,
  type QuadrantConfig,
} from "./matrixQuadrants";

interface MatrixProps {
  onToggleTask: (id: string) => Promise<boolean>;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
}

export function Matrix({ onToggleTask, onSelectTask, selectedTaskId }: MatrixProps) {
  const { tasks, loading, error, reload, asOfDate } = useViewTasks({
    status: "pending",
    limit: 100,
  });
  const today = asOfDate ?? "";
  const { patchTask } = useTaskMutations();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const movePendingRef = useRef(false);
  const [liveMessage, setLiveMessage] = useState("");

  const pendingTasks = useMemo(() => tasks.filter((t) => t.status === "pending"), [tasks]);
  const quadrantTasks = useMemo(() => groupMatrixTasks(pendingTasks, today), [pendingTasks, today]);

  const applyQuadrantMove = useCallback(
    async (taskId: string, target: MatrixQuadrant): Promise<boolean> => {
      if (movePendingRef.current) return false;
      const task = pendingTasks.find((t) => t.id === taskId);
      if (!task) return false;
      if (classifyMatrixTask(task, today) === target) return true;

      const patch = matrixDropPatch(target, today);
      movePendingRef.current = true;
      setMovePending(true);
      setMoveError(null);
      try {
        const result = await patchTask(taskId, patch, "Move matrix task");
        if (!result) {
          setMoveError("The task could not be moved.");
          setLiveMessage("Matrix move failed.");
          requestAnimationFrame(() => document.getElementById(`matrix-drag-${taskId}`)?.focus());
          return false;
        }
        setLiveMessage(
          `Moved ${task.title} to ${MATRIX_QUADRANTS.find((q) => q.id === target)?.title}.`,
        );
        void reload();
        return true;
      } catch {
        setMoveError("The task could not be moved.");
        setLiveMessage("Matrix move failed.");
        requestAnimationFrame(() => document.getElementById(`matrix-drag-${taskId}`)?.focus());
        return false;
      } finally {
        movePendingRef.current = false;
        setMovePending(false);
      }
    },
    [pendingTasks, today, patchTask, reload],
  );

  const handleDrop = useCallback(
    (target: MatrixQuadrant) => {
      const id = draggingId;
      setDraggingId(null);
      if (!id) return;
      void applyQuadrantMove(id, target);
    },
    [draggingId, applyQuadrantMove],
  );

  if ((loading && tasks.length === 0) || !today) return <ViewSkeleton />;

  return (
    <div className="flex h-full flex-col" aria-busy={movePending || undefined}>
      <div className="mb-4 flex items-center justify-between md:mb-6">
        <h1 className="text-2xl font-bold text-on-surface md:text-3xl">Matrix</h1>
        <span className="text-sm text-on-surface-muted">
          {pendingTasks.length} {pendingTasks.length === 1 ? "task" : "tasks"}
        </span>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
        >
          {error}{" "}
          <button type="button" onClick={() => void reload()} className="underline">
            Retry
          </button>
        </div>
      )}
      {moveError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
        >
          {moveError}
        </div>
      )}

      <div
        className="grid min-w-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2"
        onDragOver={(e) => e.preventDefault()}
      >
        {MATRIX_QUADRANTS.map((config) => (
          <MatrixQuadrantPanel
            key={config.id}
            config={config}
            tasks={quadrantTasks[config.id]}
            onToggle={onToggleTask}
            onSelect={onSelectTask}
            selectedTaskId={selectedTaskId}
            onDragStart={setDraggingId}
            onDrop={() => handleDrop(config.id)}
            onKeyboardMove={applyQuadrantMove}
            movePending={movePending}
            allQuadrants={MATRIX_QUADRANTS}
          />
        ))}
      </div>
    </div>
  );
}

function MatrixQuadrantPanel({
  config,
  tasks,
  onToggle,
  onSelect,
  selectedTaskId,
  onDragStart,
  onDrop,
  onKeyboardMove,
  movePending,
  allQuadrants,
}: {
  config: QuadrantConfig;
  tasks: TaskDto[];
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
  onDragStart: (id: string) => void;
  onDrop: () => void;
  onKeyboardMove: (taskId: string, target: MatrixQuadrant) => Promise<boolean>;
  movePending: boolean;
  allQuadrants: QuadrantConfig[];
}) {
  const [isOver, setIsOver] = useState(false);

  return (
    <section
      aria-labelledby={`matrix-${config.id}-heading`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        onDrop();
      }}
      className={`flex min-h-[150px] min-w-0 flex-col rounded-lg border p-2 transition-colors md:min-h-[200px] md:p-3 ${config.bgClass} ${config.borderClass} ${
        isOver ? "ring-2 ring-accent-action" : ""
      }`}
    >
      <div className="mb-2">
        <h2 id={`matrix-${config.id}-heading`} className="text-sm font-semibold text-on-surface">
          {config.title}
        </h2>
        <p className="text-xs text-on-surface-muted">{config.subtitle}</p>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {tasks.length > 0 ? (
          <ul className="space-y-1.5" aria-label={`Tasks in ${config.title}`}>
            {tasks.map((task) => (
              <li key={task.id} className="min-w-0">
                <MatrixTaskCard
                  task={task}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  isSelected={selectedTaskId === task.id}
                  onDragStart={onDragStart}
                  onKeyboardMove={onKeyboardMove}
                  movePending={movePending}
                  currentQuadrant={config.id}
                  allQuadrants={allQuadrants}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-center text-xs text-on-surface-muted">Drop tasks here</p>
        )}
      </div>
      <div className="mt-2 text-right text-xs text-on-surface-muted">
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
      </div>
    </section>
  );
}

function MatrixTaskCard({
  task,
  onToggle,
  onSelect,
  isSelected,
  onDragStart,
  onKeyboardMove,
  movePending,
  currentQuadrant,
  allQuadrants,
}: {
  task: TaskDto;
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  isSelected: boolean;
  onDragStart: (id: string) => void;
  onKeyboardMove: (taskId: string, target: MatrixQuadrant) => Promise<boolean>;
  movePending: boolean;
  currentQuadrant: MatrixQuadrant;
  allQuadrants: QuadrantConfig[];
}) {
  const [togglePending, setTogglePending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const destinations = allQuadrants.filter((q) => q.id !== currentQuadrant);

  useEffect(() => {
    if (!menuOpen) return;
    const option = menuRef.current?.querySelector<HTMLElement>(
      `[data-matrix-move-index="${activeIndex}"]`,
    );
    option?.focus();
  }, [menuOpen, activeIndex]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  const openMenu = () => {
    if (destinations.length === 0 || movePending) return;
    setActiveIndex(0);
    setMenuOpen(true);
  };

  const closeMenu = (restoreFocus = true) => {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <article
      draggable={!movePending}
      onDragStart={() => onDragStart(task.id)}
      aria-busy={togglePending || movePending || undefined}
      className={`group relative flex min-h-[44px] min-w-0 items-center gap-2 overflow-hidden rounded-md border border-border bg-surface px-2.5 py-2.5 text-sm transition-all md:min-h-0 md:py-1.5 ${
        isSelected ? "bg-accent-action/5 ring-1 ring-accent-action" : "hover:shadow-sm"
      }`}
    >
      <div className="relative flex-shrink-0">
        <button
          ref={triggerRef}
          type="button"
          id={`matrix-drag-${task.id}`}
          aria-label={`Move task ${task.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            onDragStart(task.id);
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (menuOpen) closeMenu(false);
            else openMenu();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              openMenu();
            } else if (e.key === "Escape" && menuOpen) {
              e.preventDefault();
              closeMenu();
            }
          }}
          className="flex h-6 w-6 cursor-grab items-center justify-center rounded text-on-surface-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <GripVertical size={14} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={`Move ${task.title} to quadrant`}
            className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] rounded-md border border-border bg-surface py-1 shadow-lg"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % destinations.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + destinations.length) % destinations.length);
              }
            }}
          >
            {destinations.map((quadrant, index) => (
              <button
                key={quadrant.id}
                type="button"
                role="menuitem"
                data-matrix-move-index={index}
                tabIndex={index === activeIndex ? 0 : -1}
                disabled={movePending}
                className={`flex w-full px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface-secondary focus:bg-surface-secondary focus:outline-none disabled:opacity-50 ${
                  index === activeIndex ? "bg-surface-secondary" : ""
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  void onKeyboardMove(task.id, quadrant.id).then((ok) => {
                    if (ok) closeMenu();
                  });
                }}
              >
                {quadrant.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          if (togglePending) return;
          setTogglePending(true);
          void onToggle(task.id)
            .catch(() => false)
            .finally(() => setTogglePending(false));
        }}
        disabled={togglePending}
        aria-label={`Complete task: ${task.title}`}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 border-accent-action transition-colors hover:bg-accent-action/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
      />
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        aria-label={`Open task: ${task.title}`}
        className="min-h-6 min-w-0 flex-1 truncate rounded text-left text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {task.title}
      </button>
      {task.priority && task.priority <= 2 && (
        <span className="flex-shrink-0 rounded border border-accent-action bg-surface-tertiary px-1 text-[10px] font-semibold text-on-surface-secondary">
          P{task.priority}
        </span>
      )}
    </article>
  );
}
