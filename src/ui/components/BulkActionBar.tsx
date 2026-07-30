/**
 * Bulk action bar for multiselected tasks.
 * Named region with complete, delete, move, and tag actions.
 * Preserves the legacy sticky bar layout and responsive behavior.
 *
 * Tag actions pick an existing catalog tag ID — free text is never sent as an ID.
 * Move/Tag popovers are keyboard menus (trigger semantics, arrow nav, Escape restore).
 */
import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, Trash2, FolderOpen, Tag, X } from "lucide-react";
import type { ProjectDto, TagDto } from "../api/client";

interface BulkActionBarProps {
  selectedCount: number;
  onComplete: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onMoveToProject: (projectId: string | null) => Promise<boolean>;
  onAddTag: (tagId: string) => Promise<boolean>;
  onSetPriority?: (priority: number) => Promise<boolean>;
  pending?: boolean;
  onClear: () => void;
  projects: ProjectDto[];
  tags: TagDto[];
}

type MenuKind = "project" | "tag" | null;

export function BulkActionBar({
  selectedCount,
  onComplete,
  onDelete,
  onMoveToProject,
  onAddTag,
  onSetPriority,
  pending = false,
  onClear,
  projects,
  tags,
}: BulkActionBarProps) {
  const [openMenu, setOpenMenu] = useState<MenuKind>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [localPending, setLocalPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const tagTriggerRef = useRef<HTMLButtonElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const projectMenuId = `${reactId}-project-menu`;
  const tagMenuId = `${reactId}-tag-menu`;

  const busy = localPending || pending;
  const sortedTags = [...tags].sort((a, b) => a.name.localeCompare(b.name));

  const runAction = async (action: () => Promise<boolean>) => {
    if (busy) return;
    setLocalPending(true);
    setError(null);
    try {
      const success = await action();
      if (!success) setError("The bulk action could not be completed.");
    } catch {
      setError("The bulk action could not be completed.");
    } finally {
      setLocalPending(false);
    }
  };

  const closeMenu = (restoreFocus = true) => {
    const which = openMenu;
    setOpenMenu(null);
    setActiveIndex(0);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      if (which === "project") projectTriggerRef.current?.focus();
      else if (which === "tag") tagTriggerRef.current?.focus();
    });
  };

  const openProjectMenu = () => {
    if (busy) return;
    setActiveIndex(0);
    setOpenMenu("project");
  };

  const openTagMenu = () => {
    if (busy || sortedTags.length === 0) return;
    setActiveIndex(0);
    setOpenMenu("tag");
  };

  // Focus the active menuitem when a menu opens or the index changes.
  useEffect(() => {
    if (!openMenu) return;
    const menuRef = openMenu === "project" ? projectMenuRef : tagMenuRef;
    const item = menuRef.current?.querySelector<HTMLElement>(
      `[data-bulk-menu-index="${activeIndex}"]`,
    );
    item?.focus();
  }, [openMenu, activeIndex]);

  if (selectedCount === 0) return null;

  // Project menu items: Inbox + each project.
  const projectItems: Array<{ id: string | null; label: string; color?: string }> = [
    { id: null, label: "Inbox (no project)" },
    ...projects.map((p) => ({ id: p.id, label: p.name, color: p.color })),
  ];

  const tagItems = sortedTags.map((t) => ({ id: t.id, label: t.name, color: t.color }));

  const handleMenuKeyDown = (
    event: React.KeyboardEvent,
    itemCount: number,
    onChoose: (index: number) => void,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (itemCount === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % itemCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + itemCount) % itemCount);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(itemCount - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onChoose(activeIndex);
    }
  };

  return (
    <div
      role="region"
      aria-label="Bulk task actions"
      aria-busy={busy || undefined}
      className="sticky top-0 z-10 mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-accent-action/20 bg-accent-action/10 p-2 min-[320px]:px-4"
    >
      <span className="min-w-0 text-sm font-medium text-accent-foreground">
        {selectedCount} selected
      </span>
      <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1 min-[320px]:ml-auto min-[320px]:w-auto">
        <button
          type="button"
          onClick={() => void runAction(onComplete)}
          disabled={busy}
          aria-label="Complete selected tasks"
          className="flex min-h-6 items-center gap-1.5 rounded-md bg-success/10 px-3 py-1 text-xs text-success transition-colors hover:bg-success/20 disabled:opacity-50"
        >
          <CheckCircle size={14} aria-hidden="true" />
          <span>Complete</span>
        </button>
        <button
          type="button"
          onClick={() => void runAction(onDelete)}
          disabled={busy}
          aria-label="Delete selected tasks"
          className="flex min-h-6 items-center gap-1.5 rounded-md bg-error/10 px-3 py-1 text-xs text-error transition-colors hover:bg-error/20 disabled:opacity-50"
        >
          <Trash2 size={14} aria-hidden="true" />
          <span>Delete</span>
        </button>
        {/* Move to project dropdown */}
        <div className="relative">
          <button
            ref={projectTriggerRef}
            type="button"
            onClick={() => {
              if (openMenu === "project") closeMenu(false);
              else {
                setOpenMenu(null);
                openProjectMenu();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                if (openMenu === "project") return;
                e.preventDefault();
                openProjectMenu();
              } else if (e.key === "Escape" && openMenu === "project") {
                e.preventDefault();
                closeMenu(true);
              }
            }}
            disabled={busy}
            aria-label="Move selected tasks"
            aria-haspopup="menu"
            aria-expanded={openMenu === "project"}
            aria-controls={openMenu === "project" ? projectMenuId : undefined}
            className="flex min-h-6 items-center gap-1.5 rounded-md bg-surface-tertiary px-3 py-1 text-xs text-on-surface-secondary transition-colors hover:bg-border disabled:opacity-50"
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span>Move</span>
          </button>
          {openMenu === "project" && (
            <div
              ref={projectMenuRef}
              id={projectMenuId}
              role="menu"
              aria-label="Move selected tasks to project"
              className="absolute right-0 top-full mt-1 max-h-60 w-48 overflow-auto rounded-lg border border-border bg-surface shadow-lg z-20"
              onKeyDown={(e) =>
                handleMenuKeyDown(e, projectItems.length, (index) => {
                  const item = projectItems[index];
                  if (!item) return;
                  void runAction(() => onMoveToProject(item.id));
                  closeMenu(true);
                })
              }
            >
              {projectItems.map((item, index) => (
                <button
                  key={item.id ?? "inbox"}
                  type="button"
                  role="menuitem"
                  data-bulk-menu-index={index}
                  tabIndex={index === activeIndex ? 0 : -1}
                  disabled={busy}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    void runAction(() => onMoveToProject(item.id));
                    closeMenu(true);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-secondary focus:bg-surface-secondary focus:outline-none disabled:opacity-50 ${
                    index === activeIndex ? "bg-surface-secondary" : ""
                  }`}
                >
                  {item.color && (
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                  )}
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Catalog tag picker — UUIDs only */}
        <div className="relative">
          <button
            ref={tagTriggerRef}
            type="button"
            onClick={() => {
              if (openMenu === "tag") closeMenu(false);
              else {
                setOpenMenu(null);
                if (sortedTags.length > 0) openTagMenu();
                else setOpenMenu("tag");
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                if (openMenu === "tag") return;
                e.preventDefault();
                if (sortedTags.length > 0) openTagMenu();
                else setOpenMenu("tag");
              } else if (e.key === "Escape" && openMenu === "tag") {
                e.preventDefault();
                closeMenu(true);
              }
            }}
            disabled={busy}
            aria-label="Add tag to selected tasks"
            aria-haspopup="menu"
            aria-expanded={openMenu === "tag"}
            aria-controls={openMenu === "tag" ? tagMenuId : undefined}
            className="flex min-h-6 items-center gap-1.5 rounded-md bg-surface-tertiary px-3 py-1 text-xs text-on-surface-secondary transition-colors hover:bg-border disabled:opacity-50"
          >
            <Tag size={14} aria-hidden="true" />
            <span>Tag</span>
          </button>
          {openMenu === "tag" && (
            <div
              ref={tagMenuRef}
              id={tagMenuId}
              role="menu"
              aria-label="Add tag to selected tasks"
              className="absolute right-0 top-full mt-1 max-h-60 w-48 overflow-auto rounded-lg border border-border bg-surface shadow-lg z-20"
              onKeyDown={(e) =>
                handleMenuKeyDown(e, tagItems.length, (index) => {
                  const item = tagItems[index];
                  if (!item) return;
                  void runAction(() => onAddTag(item.id));
                  closeMenu(true);
                })
              }
            >
              {tagItems.length === 0 ? (
                <p className="px-3 py-2 text-sm text-on-surface-muted">No tags yet</p>
              ) : (
                tagItems.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    data-bulk-menu-index={index}
                    tabIndex={index === activeIndex ? 0 : -1}
                    disabled={busy}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => {
                      void runAction(() => onAddTag(item.id));
                      closeMenu(true);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-secondary focus:bg-surface-secondary focus:outline-none disabled:opacity-50 ${
                      index === activeIndex ? "bg-surface-secondary" : ""
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    {item.label}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {/* Priority (optional) */}
        {onSetPriority && (
          <select
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (Number.isFinite(val)) void runAction(() => onSetPriority(val));
              e.target.value = "";
            }}
            disabled={busy}
            aria-label="Set priority"
            className="rounded-md bg-surface-tertiary px-2 py-1 text-xs text-on-surface-secondary disabled:opacity-50"
            defaultValue=""
          >
            <option value="" disabled>
              Priority
            </option>
            <option value="1">P1</option>
            <option value="2">P2</option>
            <option value="3">P3</option>
            <option value="4">P4</option>
          </select>
        )}
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          aria-label="Clear selection"
          className="flex min-h-6 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-on-surface-muted transition-colors hover:bg-surface-tertiary disabled:opacity-50"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p role="alert" className="w-full text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}
