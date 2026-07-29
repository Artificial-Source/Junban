import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import type { View } from "../hooks/useRouting";

interface SidebarHeaderProps {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onAddTask: () => void;
  onSearch: () => void;
}

function SidebarHeader({ collapsed, onToggleCollapsed, onAddTask, onSearch }: SidebarHeaderProps) {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

  return (
    <div className={`shrink-0 py-4 ${collapsed ? "px-2" : "px-4"}`}>
      <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
        {!collapsed ? (
          <div className="flex items-center gap-2">
            <img
              src="/images/logo.svg"
              alt="Junban logo"
              className="h-7 w-7 shrink-0 rounded-md ring-1 ring-border/60 bg-white object-contain p-1"
            />
            <h2 className="text-base font-bold text-on-surface tracking-tight">Junban</h2>
          </div>
        ) : (
          <img
            src="/images/logo.svg"
            alt="Junban logo"
            className="h-7 w-7 shrink-0 rounded-md ring-1 ring-border/60 bg-white object-contain p-1"
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
          </button>
        )}
      </div>
      {onAddTask && (
        <button
          onClick={onAddTask}
          className={`mt-3 w-full flex items-center rounded-lg bg-accent-action text-on-accent-action font-medium text-sm transition-colors hover:bg-accent-action-hover ${
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
          disabled
          aria-label="Search (unavailable)"
          className="mt-2 w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors opacity-50 cursor-not-allowed"
        >
          <Search size={16} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-muted border border-border/50">
            {isMac ? "\u2318K" : "Ctrl+K"}
          </kbd>
        </button>
      )}
    </div>
  );
}

interface NavItem {
  id: View;
  label: string;
  icon: typeof Inbox;
  countKey?: "inbox" | "today";
}

import {
  Inbox,
  CalendarDays,
  Clock,
  SlidersHorizontal,
  MessageSquare,
  Settings,
} from "lucide-react";

const NAV_ITEMS: NavItem[] = [
  { id: "inbox", label: "Inbox", icon: Inbox, countKey: "inbox" },
  { id: "today", label: "Today", icon: CalendarDays, countKey: "today" },
];

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  onAddTask: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  inboxCount: number;
  todayCount: number;
}

export function Sidebar({
  currentView,
  onNavigate,
  onAddTask,
  collapsed,
  onToggleCollapsed,
  inboxCount,
  todayCount,
}: SidebarProps) {
  const countMap: Record<string, number> = { inbox: inboxCount, today: todayCount };

  return (
    <aside
      aria-label="Main navigation"
      className={`relative z-20 h-full min-h-0 max-h-full max-w-full border-r border-border bg-surface-secondary flex flex-col transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        collapsed ? "w-16 overflow-visible" : "w-sidebar overflow-y-auto overflow-x-hidden"
      }`}
    >
      <SidebarHeader
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        onAddTask={onAddTask}
        onSearch={() => {}}
      />

      <nav
        aria-label="Views"
        className={`flex-1 shrink-0 flex flex-col ${collapsed ? "px-2" : "px-3"}`}
      >
        <div className="flex-1 shrink-0 scrollbar-hide space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            const count = item.countKey ? countMap[item.countKey] : undefined;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={isActive ? "page" : undefined}
                className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors ${
                  collapsed ? "justify-center" : "gap-3"
                } ${
                  isActive
                    ? "bg-accent-action/10 text-accent-foreground font-medium"
                    : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                }`}
              >
                <Icon size={18} strokeWidth={isActive ? 2.25 : 1.75} />
                {!collapsed && <span className="flex-1">{item.label}</span>}
                {!collapsed && count !== undefined && count > 0 && (
                  <span className="text-xs tabular-nums text-on-surface-muted">{count}</span>
                )}
              </button>
            );
          })}

          {/* Upcoming — visible but disabled (Phase 2+) */}
          <button
            disabled
            aria-label="Upcoming (unavailable)"
            className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors opacity-50 cursor-not-allowed ${
              collapsed ? "justify-center" : "gap-3"
            } text-on-surface-secondary`}
          >
            <Clock size={18} strokeWidth={1.75} />
            {!collapsed && <span className="flex-1">Upcoming</span>}
          </button>

          {/* Filters & Labels — visible but disabled (Phase 2+) */}
          <button
            disabled
            aria-label="Filters & Labels (unavailable)"
            className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors opacity-50 cursor-not-allowed ${
              collapsed ? "justify-center" : "gap-3"
            } text-on-surface-secondary`}
          >
            <SlidersHorizontal size={18} strokeWidth={1.75} />
            {!collapsed && <span className="flex-1">Filters & Labels</span>}
          </button>
        </div>

        {/* Workspace section */}
        <div
          className={`shrink-0 border-t border-border/60 ${collapsed ? "pt-2 pb-3" : "pt-3 pb-3"}`}
        >
          {!collapsed && (
            <h3 className="text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider mb-1 px-3">
              Workspace
            </h3>
          )}
          <ul className="space-y-0.5">
            <li>
              <button
                disabled
                aria-label="AI Chat (unavailable)"
                className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors opacity-50 cursor-not-allowed ${
                  collapsed ? "justify-center" : "gap-3"
                } text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface`}
              >
                <MessageSquare size={18} strokeWidth={1.75} />
                {!collapsed && "AI Chat"}
              </button>
            </li>
            <li>
              <button
                disabled
                aria-label="Settings (unavailable)"
                className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors opacity-50 cursor-not-allowed ${
                  collapsed ? "justify-center" : "gap-3"
                } text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface`}
              >
                <Settings size={18} strokeWidth={1.75} />
                {!collapsed && "Settings"}
              </button>
            </li>
          </ul>
        </div>
      </nav>
    </aside>
  );
}
