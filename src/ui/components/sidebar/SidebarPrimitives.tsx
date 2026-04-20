import { type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import {
  Inbox,
  CalendarDays,
  CalendarRange,
  Clock,
  CheckCircle2,
  XCircle,
  BarChart3,
  Lightbulb,
  Grid2x2,
  Zap,
  ChevronDown,
  ChevronRight,
  GripVertical,
} from "lucide-react";
import type { GeneralSettings } from "../../context/SettingsContext.js";

export function CollapsedTooltip({ visible, label }: { visible: boolean; label: string }) {
  if (!visible) return null;

  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-on-surface opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {label}
    </span>
  );
}

export const NAV_ITEMS: Array<{
  id: string;
  label: string;
  icon: typeof Inbox;
  countKey?: "inbox" | "today";
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox, countKey: "inbox" },
  { id: "today", label: "Today", icon: CalendarDays, countKey: "today" },
  { id: "upcoming", label: "Upcoming", icon: Clock },
  { id: "calendar", label: "Calendar", icon: CalendarRange },
  { id: "completed", label: "Completed", icon: CheckCircle2 },
  { id: "cancelled", label: "Cancelled", icon: XCircle },
  { id: "matrix", label: "Matrix", icon: Grid2x2 },
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "someday", label: "Someday / Maybe", icon: Lightbulb },
  { id: "dopamine-menu", label: "Quick Wins", icon: Zap },
];

export const CORE_VIEWS = new Set(["inbox", "today", "upcoming"]);

export const DEFAULT_SIDEBAR_ORDER = [
  "inbox",
  "today",
  "upcoming",
  "calendar",
  "completed",
  "cancelled",
  "matrix",
  "stats",
  "someday",
  "dopamine-menu",
  "favorite-views",
  "favorites",
  "projects",
  "my-views",
  "tools",
];

export const SECTION_IDS = new Set([
  "favorite-views",
  "favorites",
  "projects",
  "my-views",
  "tools",
]);

export const NAV_FEATURE_MAP: Record<string, keyof GeneralSettings> = {
  calendar: "feature_calendar",
  completed: "feature_completed",
  cancelled: "feature_cancelled",
  matrix: "feature_matrix",
  stats: "feature_stats",
  someday: "feature_someday",
  "dopamine-menu": "feature_dopamine_menu",
};

export function SortableNavItem({ id, children }: { id: string; children: ReactNode }) {
  // Startup-safe fallback wrapper. Drag listeners are injected by the lazy DnD path.
  return (
    <div data-nav-id={id} role="presentation" style={{ opacity: 1 }}>
      {children}
    </div>
  );
}

export function SortableSection({
  id,
  children,
}: {
  id: string;
  children: (dragHandleListeners: Record<string, unknown>) => ReactNode;
}) {
  return (
    <div role="group" data-section-id={id}>
      {children({})}
    </div>
  );
}

export function SectionHeader({
  label,
  expanded,
  onToggle,
  trailing,
  dragHandleListeners,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
  dragHandleListeners?: Record<string, unknown>;
}) {
  return (
    <div className="group/section flex items-center mt-5 mb-1 px-3">
      {dragHandleListeners && (
        <button
          {...dragHandleListeners}
          aria-label={`Drag ${label} section`}
          className="p-0.5 -ml-1 mr-0.5 rounded text-on-surface-muted/0 group-hover/section:text-on-surface-muted hover:!text-on-surface-secondary cursor-grab transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <GripVertical size={12} />
        </button>
      )}
      <button
        onClick={onToggle}
        className="flex items-center gap-1 text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider text-left hover:text-on-surface-secondary transition-colors flex-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded px-1 -ml-1"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {trailing}
    </div>
  );
}

export function renderNavButton(
  _id: string,
  label: string,
  icon: typeof Inbox | string,
  isActive: boolean,
  onClick: () => void,
  collapsed: boolean,
  count?: number,
  onCtxMenu?: (e: ReactMouseEvent) => void,
) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onCtxMenu}
      aria-current={isActive ? "page" : undefined}
      className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
        collapsed ? "justify-center" : "gap-3"
      } ${
        isActive
          ? "bg-accent/10 text-accent font-medium"
          : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
      }`}
    >
      {typeof icon === "string" ? (
        <span className="text-lg leading-none w-[18px] text-center flex-shrink-0">{icon}</span>
      ) : (
        (() => {
          const Icon = icon;
          return <Icon size={18} strokeWidth={isActive ? 2.25 : 1.75} />;
        })()
      )}
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && count !== undefined && count > 0 && (
        <span className="text-xs tabular-nums text-on-surface-muted">{count}</span>
      )}
      <CollapsedTooltip visible={collapsed} label={label} />
    </button>
  );
}
