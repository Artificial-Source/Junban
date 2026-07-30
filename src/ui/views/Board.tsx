/**
 * Kanban board view with section columns and cross-column moves.
 * Preserves the legacy board presentation with draggable cards and droppable columns.
 * Uses native HTML5 drag-and-drop plus keyboard-operable move controls.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Calendar, GripVertical } from "lucide-react";
import type { TaskDto, ProjectDto, SectionDto, TagDto } from "../api/client";
import { calendarDayKey, formatDate } from "../lib/dates";

interface BoardProps {
  project: ProjectDto;
  tasks: TaskDto[];
  sections: SectionDto[];
  onMoveTask: (taskId: string, sectionId: string | null) => Promise<boolean>;
  onToggleTask: (id: string) => Promise<boolean>;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  tagMap?: Map<string, TagDto>;
}

const PRIORITY_BORDER_COLORS: Record<number, string> = {
  1: "border-l-3 border-l-priority-1",
  2: "border-l-3 border-l-priority-2",
  3: "border-l-2 border-l-priority-3",
  4: "",
};

export interface BoardColumnOption {
  id: string | null;
  label: string;
}

export function boardColumnOptions(sections: SectionDto[]): BoardColumnOption[] {
  return [{ id: null, label: "No Section" }, ...sections.map((s) => ({ id: s.id, label: s.name }))];
}

export function Board({
  project: _project,
  tasks,
  sections,
  onMoveTask,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  tagMap,
}: BoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOverColumnRef = useRef<string | null>(null);
  const today = calendarDayKey(new Date().toISOString())!;
  const columns = boardColumnOptions(sections);

  const handleDragStart = useCallback((id: string) => {
    setDraggingId(id);
  }, []);

  const handleDrop = useCallback(
    (columnId: string | null) => {
      const draggingIdCopy = draggingId;
      setDraggingId(null);
      dragOverColumnRef.current = null;
      if (!draggingIdCopy) return;
      void onMoveTask(draggingIdCopy, columnId);
    },
    [draggingId, onMoveTask],
  );

  // Group tasks by section
  const unsectioned = tasks.filter((t) => !t.section_id);
  // Always show No Section column so keyboard movers can target it even when empty.
  const showUnsectioned = unsectioned.length > 0 || sections.length > 0;

  return (
    <div
      className="flex gap-4 overflow-x-auto pb-4"
      onDragOver={(e) => e.preventDefault()}
      role="region"
      aria-label={`${_project.name} board`}
    >
      {showUnsectioned && (
        <BoardColumn
          columnId="none"
          title="No Section"
          tasks={unsectioned}
          columns={columns}
          onToggle={onToggleTask}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
          onDragStart={handleDragStart}
          onDrop={() => handleDrop(null)}
          onMoveTask={onMoveTask}
          tagMap={tagMap}
          todayKey={today}
        />
      )}

      {sections.map((section) => (
        <BoardColumn
          key={section.id}
          columnId={section.id}
          title={section.name}
          tasks={tasks.filter((t) => t.section_id === section.id)}
          columns={columns}
          onToggle={onToggleTask}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
          onDragStart={handleDragStart}
          onDrop={() => handleDrop(section.id)}
          onMoveTask={onMoveTask}
          tagMap={tagMap}
          todayKey={today}
        />
      ))}
    </div>
  );
}

interface BoardColumnProps {
  columnId: string;
  title: string;
  tasks: TaskDto[];
  columns: BoardColumnOption[];
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
  onDragStart: (id: string) => void;
  onDrop: () => void;
  onMoveTask: (taskId: string, sectionId: string | null) => Promise<boolean>;
  tagMap?: Map<string, TagDto>;
  todayKey: string;
}

function BoardColumn({
  columnId: _columnId,
  title,
  tasks,
  columns,
  onToggle,
  onSelect,
  selectedTaskId,
  onDragStart,
  onDrop,
  onMoveTask,
  tagMap,
  todayKey,
}: BoardColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <section
      aria-label={`${title} board column`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        onDrop();
      }}
      className={`flex w-full flex-shrink-0 flex-col rounded-lg bg-surface-secondary p-3 transition-colors duration-150 md:min-w-[280px] md:max-w-[320px] ${
        isDragOver ? "ring-2 ring-accent-action/40" : ""
      }`}
    >
      <h3 className="mb-2 text-sm font-semibold text-on-surface-secondary">
        {title}
        <span className="ml-2 text-xs font-normal text-on-surface-muted">{tasks.length}</span>
      </h3>
      <div className="space-y-2 min-h-[40px]">
        {tasks.map((task) => (
          <BoardCard
            key={task.id}
            task={task}
            columns={columns}
            onToggle={onToggle}
            onSelect={onSelect}
            isSelected={selectedTaskId === task.id}
            onDragStart={onDragStart}
            onMoveTask={onMoveTask}
            tagMap={tagMap}
            todayKey={todayKey}
          />
        ))}
        {tasks.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-on-surface-muted">
            Drop tasks here
          </div>
        )}
      </div>
    </section>
  );
}

function BoardCard({
  task,
  columns,
  onToggle,
  onSelect,
  isSelected,
  onDragStart,
  onMoveTask,
  tagMap,
  todayKey,
}: {
  task: TaskDto;
  columns: BoardColumnOption[];
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  isSelected: boolean;
  onDragStart: (id: string) => void;
  onMoveTask: (taskId: string, sectionId: string | null) => Promise<boolean>;
  tagMap?: Map<string, TagDto>;
  todayKey: string;
}) {
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [moveError, setMoveError] = useState<string | null>(null);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const priorityBorder = task.priority ? (PRIORITY_BORDER_COLORS[task.priority] ?? "") : "";
  const dueDay = task.due_date ? calendarDayKey(task.due_date) : null;
  const isOverdue = dueDay !== null && task.status === "pending" && dueDay < todayKey;
  const isCompleted = task.status === "completed";

  const currentSectionId = task.section_id ?? null;
  const destinations = columns.filter((column) => column.id !== currentSectionId);

  useEffect(() => {
    if (!menuOpen) return;
    const option = menuRef.current?.querySelector<HTMLElement>(
      `[data-board-move-index="${activeIndex}"]`,
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
    if (destinations.length === 0 || pending) return;
    setMoveError(null);
    setActiveIndex(0);
    setMenuOpen(true);
  };

  const closeMenu = (restoreFocus = true) => {
    setMenuOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const commitMove = async (sectionId: string | null) => {
    if (pending) return;
    setPending(true);
    setMoveError(null);
    try {
      const ok = await onMoveTask(task.id, sectionId);
      if (!ok) {
        setMoveError("Could not move task.");
        return;
      }
      closeMenu();
    } catch {
      setMoveError("Could not move task.");
    } finally {
      setPending(false);
    }
  };

  return (
    <article
      draggable
      onDragStart={() => onDragStart(task.id)}
      aria-busy={pending || undefined}
      className={`group relative rounded-md border border-border bg-surface p-3 shadow-sm transition-all duration-150 ${priorityBorder} ${
        isSelected ? "ring-1 ring-accent-action bg-accent-action/5" : "hover:shadow-md"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="relative flex-shrink-0">
          <button
            ref={triggerRef}
            type="button"
            aria-label={`Move task ${task.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            draggable
            onDragStart={(e) => {
              // Keep native pointer drag on the grip; menu is for keyboard/click.
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
            className="mt-0.5 flex h-6 w-6 cursor-grab items-center justify-center rounded text-on-surface-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <GripVertical size={14} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={`Move ${task.title} to section`}
              className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] rounded-md border border-border bg-surface py-1 shadow-lg"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeMenu();
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((index) => (index + 1) % destinations.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex(
                    (index) => (index - 1 + destinations.length) % destinations.length,
                  );
                } else if (e.key === "Home") {
                  e.preventDefault();
                  setActiveIndex(0);
                } else if (e.key === "End") {
                  e.preventDefault();
                  setActiveIndex(destinations.length - 1);
                }
              }}
            >
              {destinations.map((column, index) => (
                <button
                  key={column.id ?? "none"}
                  type="button"
                  role="menuitem"
                  data-board-move-index={index}
                  tabIndex={index === activeIndex ? 0 : -1}
                  disabled={pending}
                  className={`flex w-full px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface-secondary focus:bg-surface-secondary focus:outline-none disabled:opacity-50 ${
                    index === activeIndex ? "bg-surface-secondary" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void commitMove(column.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void commitMove(column.id);
                    }
                  }}
                >
                  {column.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            if (pending) return;
            setPending(true);
            void onToggle(task.id)
              .catch(() => false)
              .finally(() => setPending(false));
          }}
          disabled={pending}
          aria-label={
            isCompleted ? `Mark task incomplete: ${task.title}` : `Complete task: ${task.title}`
          }
          className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 ${
            isCompleted ? "bg-success border-success" : "border-accent-action"
          }`}
        >
          {isCompleted && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className="text-surface">
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {!isCompleted && task.priority && (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: `var(--color-priority-${task.priority})` }}
            />
          )}
        </button>
        <button
          type="button"
          onClick={() => onSelect(task.id)}
          aria-label={`Open task: ${task.title}`}
          className={`min-h-6 min-w-0 flex-1 rounded text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
            isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
          }`}
        >
          {task.title}
        </button>
      </div>
      {(task.tag_ids.length > 0 || task.due_date) && (
        <div className="ml-8 mt-2 flex flex-wrap items-center gap-1.5">
          {task.tag_ids.length > 0 &&
            tagMap &&
            task.tag_ids.map((tagId) => {
              const tag = tagMap.get(tagId);
              if (!tag) return null;
              return (
                <span
                  key={tagId}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-tertiary px-1.5 font-mono text-xs text-on-surface-secondary"
                >
                  {tag.color && (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                  )}
                  {tag.name}
                </span>
              );
            })}
          {task.due_date && (
            <span
              className={`flex flex-shrink-0 items-center gap-1 text-xs ${
                isOverdue ? "font-medium text-error" : "text-on-surface-muted"
              }`}
            >
              <Calendar size={11} aria-hidden="true" />
              {formatDate(task.due_date)}
            </span>
          )}
        </div>
      )}
      {moveError && (
        <p role="alert" className="ml-8 mt-1 text-xs text-error">
          {moveError}
        </p>
      )}
    </article>
  );
}
