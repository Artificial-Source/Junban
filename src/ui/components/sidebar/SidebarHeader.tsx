import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { CollapsedTooltip } from "./SidebarPrimitives.js";

interface SidebarHeaderProps {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onAddTask?: () => void;
  onSearch?: () => void;
}

export function SidebarHeader({
  collapsed,
  onToggleCollapsed,
  onAddTask,
  onSearch,
}: SidebarHeaderProps) {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

  return (
    <div className={`py-4 ${collapsed ? "px-2" : "px-4"}`}>
      <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
        {!collapsed ? (
          <div className="flex items-center gap-2">
            <img
              src="/images/logo.webp"
              alt="Junban logo"
              className="h-7 w-7 shrink-0 rounded-md ring-1 ring-border/60 bg-surface object-contain p-1 dark:invert"
            />
            <h2 className="text-base font-bold text-on-surface tracking-tight">Junban</h2>
          </div>
        ) : (
          <img
            src="/images/logo.webp"
            alt="Junban logo"
            className="h-7 w-7 shrink-0 rounded-md ring-1 ring-border/60 bg-surface object-contain p-1 dark:invert"
          />
        )}
        {onToggleCollapsed && !collapsed && (
          <button
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            className="p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        {onToggleCollapsed && collapsed && (
          <button
            onClick={onToggleCollapsed}
            aria-label="Expand sidebar"
            className="group relative mt-2 p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
          >
            <ChevronRight size={16} />
            <CollapsedTooltip visible label="Expand sidebar" />
          </button>
        )}
      </div>
      {onAddTask && (
        <button
          onClick={onAddTask}
          className={`mt-3 w-full flex items-center rounded-lg bg-accent text-white font-medium text-sm transition-colors hover:bg-accent-hover motion-safe:transition-transform motion-safe:hover:scale-[1.02] motion-safe:active:scale-[0.98] ${
            collapsed ? "justify-center p-2" : "gap-2 px-3 py-2"
          }`}
        >
          <Plus size={18} />
          {!collapsed && "Add task"}
        </button>
      )}
      {onSearch && !collapsed && (
        <button
          onClick={onSearch}
          className="mt-2 w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
        >
          <Search size={16} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-muted border border-border/50">
            {isMac ? "\u2318K" : "Ctrl+K"}
          </kbd>
        </button>
      )}
      {onSearch && collapsed && (
        <button
          onClick={onSearch}
          aria-label="Search"
          className="group relative mt-2 w-full flex items-center justify-center p-2 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
        >
          <Search size={16} />
          <CollapsedTooltip visible label="Search" />
        </button>
      )}
    </div>
  );
}
