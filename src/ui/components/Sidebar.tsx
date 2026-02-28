import { useState, useMemo, useCallback, type ReactNode, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Inbox,
  CalendarDays,
  CalendarRange,
  Clock,
  Settings,
  MessageSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  SlidersHorizontal,
  CheckCircle2,
  Star,
  BarChart3,
  Lightbulb,
  XCircle,
  Grid2x2,
  Filter,
  EyeOff,
  Eye,
  RotateCcw,
  ArrowUpToLine,
  ArrowDownToLine,
  Home,
  Link,
  Heart,
  GripVertical,
} from "lucide-react";
import type { Project } from "../../core/types.js";
import type { PanelInfo, ViewInfo } from "../api/index.js";
import { useGeneralSettings, type GeneralSettings } from "../context/SettingsContext.js";
import { ContextMenu } from "./ContextMenu.js";

function CollapsedTooltip({ visible, label }: { visible: boolean; label: string }) {
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

interface SidebarProps {
  currentView: string;
  onNavigate: (view: string, id?: string) => void;
  onOpenSettings?: () => void;
  projects: Project[];
  selectedProjectId: string | null;
  panels?: PanelInfo[];
  pluginViews?: ViewInfo[];
  selectedPluginViewId?: string | null;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  projectTaskCounts?: Map<string, number>;
  projectCompletedCounts?: Map<string, number>;
  onAddTask?: () => void;
  onSearch?: () => void;
  inboxCount?: number;
  todayCount?: number;
  onOpenProjectModal?: () => void;
  builtinPluginIds?: Set<string>;
  savedFilters?: Array<{ id: string; name: string; query: string; color?: string }>;
  selectedFilterId?: string | null;
}

const NAV_ITEMS: Array<{
  id: string;
  label: string;
  icon: typeof Inbox;
  countKey?: "inbox" | "today";
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox, countKey: "inbox" },
  { id: "today", label: "Today", icon: CalendarDays, countKey: "today" },
  { id: "upcoming", label: "Upcoming", icon: Clock },
  { id: "calendar", label: "Calendar", icon: CalendarRange },
  { id: "filters-labels", label: "Filters & Labels", icon: SlidersHorizontal },
  { id: "completed", label: "Completed", icon: CheckCircle2 },
  { id: "cancelled", label: "Cancelled", icon: XCircle },
  { id: "matrix", label: "Matrix", icon: Grid2x2 },
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "someday", label: "Someday", icon: Lightbulb },
];

const CORE_VIEWS = new Set(["inbox", "today", "upcoming"]);

// All sidebar items in default order — nav items interleaved with section headers
const DEFAULT_SIDEBAR_ORDER = [
  "inbox", "today", "upcoming", "calendar", "filters-labels",
  "completed", "cancelled", "matrix", "stats", "someday",
  "favorite-views", "favorites", "projects", "my-views", "tools",
];

const SECTION_IDS = new Set(["favorite-views", "favorites", "projects", "my-views", "tools"]);

const NAV_FEATURE_MAP: Record<string, keyof GeneralSettings> = {
  calendar: "feature_calendar",
  "filters-labels": "feature_filters_labels",
  completed: "feature_completed",
  cancelled: "feature_cancelled",
  matrix: "feature_matrix",
  stats: "feature_stats",
  someday: "feature_someday",
};

function SortableNavItem({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

function SortableSection({
  id,
  children,
}: {
  id: string;
  children: (dragHandleListeners: Record<string, any>) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} data-section-id={id}>
      {children(listeners ?? {})}
    </div>
  );
}

function SectionHeader({
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
  dragHandleListeners?: Record<string, any>;
}) {
  return (
    <div className="group/section flex items-center mt-5 mb-1 px-3">
      {dragHandleListeners && (
        <button
          {...dragHandleListeners}
          aria-label={`Drag ${label} section`}
          className="p-0.5 -ml-1 mr-0.5 rounded text-on-surface-muted/0 group-hover/section:text-on-surface-muted hover:!text-on-surface-secondary cursor-grab transition-colors"
        >
          <GripVertical size={12} />
        </button>
      )}
      <button
        onClick={onToggle}
        className="flex items-center gap-1 text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider text-left hover:text-on-surface-secondary transition-colors flex-1"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {trailing}
    </div>
  );
}

export function Sidebar({
  currentView,
  onNavigate,
  onOpenSettings,
  projects,
  selectedProjectId,
  panels = [],
  pluginViews = [],
  selectedPluginViewId,
  collapsed = false,
  onToggleCollapsed,
  projectTaskCounts,
  projectCompletedCounts,
  onAddTask,
  onSearch,
  inboxCount,
  todayCount,
  onOpenProjectModal,
  builtinPluginIds = new Set(),
  savedFilters = [],
  selectedFilterId,
}: SidebarProps) {
  const { settings, updateSetting } = useGeneralSettings();
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [toolsExpanded, setToolsExpanded] = useState(true);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [favoriteViewsExpanded, setFavoriteViewsExpanded] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<{ itemId: string; x: number; y: number } | null>(null);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const visibleNavItems = useMemo(() => {
    const hidden = new Set<string>();
    if (settings.feature_cancelled === "false") hidden.add("cancelled");
    if (settings.feature_stats === "false") hidden.add("stats");
    if (settings.feature_someday === "false") hidden.add("someday");
    if (settings.feature_matrix === "false") hidden.add("matrix");
    if (settings.feature_calendar === "false") hidden.add("calendar");
    if (settings.feature_filters_labels === "false") hidden.add("filters-labels");
    if (settings.feature_completed === "false") hidden.add("completed");
    return NAV_ITEMS.filter((item) => !hidden.has(item.id));
  }, [
    settings.feature_cancelled,
    settings.feature_stats,
    settings.feature_someday,
    settings.feature_matrix,
    settings.feature_calendar,
    settings.feature_filters_labels,
    settings.feature_completed,
  ]);

  // Favorite views
  const favoriteViewIds = useMemo(() => {
    const str = settings.sidebar_favorite_views;
    if (!str) return new Set<string>();
    return new Set(str.split(",").filter(Boolean));
  }, [settings.sidebar_favorite_views]);

  const favoriteNavItems = useMemo(
    () => visibleNavItems.filter((item) => favoriteViewIds.has(item.id)),
    [visibleNavItems, favoriteViewIds],
  );

  const navItemMap = useMemo(
    () => new Map(NAV_ITEMS.map((item) => [item.id, item])),
    [],
  );

  const favoriteProjects = useMemo(
    () => projects.filter((p) => p.isFavorite && !p.archived),
    [projects],
  );

  const projectTree = useMemo(() => {
    const nonArchived = projects.filter((p) => !p.archived);
    const roots = nonArchived.filter((p) => p.parentId === null);
    const childrenMap = new Map<string, typeof nonArchived>();
    for (const p of nonArchived) {
      if (p.parentId) {
        const existing = childrenMap.get(p.parentId) ?? [];
        existing.push(p);
        childrenMap.set(p.parentId, existing);
      }
    }
    return { roots, childrenMap };
  }, [projects]);

  // ── Group views by slot ──
  const viewsBySlot = useMemo(() => {
    const navigation: ViewInfo[] = [];
    const tools: ViewInfo[] = [];
    const workspace: ViewInfo[] = [];

    for (const view of pluginViews) {
      const effectiveSlot =
        view.slot === "navigation" && builtinPluginIds.has(view.pluginId)
          ? "navigation"
          : view.slot === "navigation"
            ? "tools" // non-builtin plugins can't use navigation slot
            : view.slot;

      if (effectiveSlot === "navigation") navigation.push(view);
      else if (effectiveSlot === "workspace") workspace.push(view);
      else tools.push(view);
    }

    return { navigation, tools, workspace };
  }, [pluginViews, builtinPluginIds]);

  const toggleParentExpanded = (id: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const countMap: Record<string, number | undefined> = {
    inbox: inboxCount,
    today: todayCount,
  };

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

  // ── Reusable renderers ──

  const renderNavButton = (
    _id: string,
    label: string,
    icon: typeof Inbox | string,
    isActive: boolean,
    onClick: () => void,
    count?: number,
    onCtxMenu?: (e: ReactMouseEvent) => void,
  ) => (
    <button
      onClick={onClick}
      onContextMenu={onCtxMenu}
      aria-current={isActive ? "page" : undefined}
      className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors ${
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

  const renderPluginViewButton = (view: ViewInfo) => {
    const isActive = currentView === "plugin-view" && selectedPluginViewId === view.id;
    return renderNavButton(`plugin-view-${view.id}`, view.name, view.icon, isActive, () =>
      onNavigate("plugin-view", view.id),
    );
  };

  const renderProjectButton = (project: Project) => {
    const isActive = currentView === "project" && selectedProjectId === project.id;
    const pendingCount = projectTaskCounts?.get(project.id) ?? 0;
    const completedCount = projectCompletedCounts?.get(project.id) ?? 0;
    const totalCount = pendingCount + completedCount;
    const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
    return (
      <button
        onClick={() => onNavigate("project", project.id)}
        aria-current={isActive ? "page" : undefined}
        className={`w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center gap-3 transition-colors ${
          isActive
            ? "bg-accent/10 text-accent font-medium"
            : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
        }`}
      >
        {project.icon ? (
          <span aria-hidden="true" className="flex-shrink-0 text-base leading-none">
            {project.icon}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: project.color }}
          />
        )}
        <span className="flex-1 truncate">{project.name}</span>
        {totalCount > 0 && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-12 h-1 rounded-full bg-surface-tertiary overflow-hidden" title={`${progressPct}% complete`}>
              <div
                className="h-full rounded-full bg-accent/60 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-xs tabular-nums text-on-surface-muted">{pendingCount}</span>
          </div>
        )}
      </button>
    );
  };

  // Whether we have tools-slot content to show
  const hasToolsContent = viewsBySlot.tools.length > 0 || panels.length > 0;

  // Unified sidebar order: nav items + sections in one flat sortable list
  const orderedSidebarItems = useMemo(() => {
    // Determine which items are currently visible
    const visibleIds = new Set<string>();
    for (const item of visibleNavItems) {
      if (!favoriteViewIds.has(item.id)) visibleIds.add(item.id);
    }
    if (favoriteNavItems.length > 0) visibleIds.add("favorite-views");
    if (favoriteProjects.length > 0) visibleIds.add("favorites");
    if (projects.length > 0 || onOpenProjectModal) visibleIds.add("projects");
    if (savedFilters.length > 0) visibleIds.add("my-views");
    if (hasToolsContent) visibleIds.add("tools");

    // Get stored order (migrate from old sidebar_nav_order if needed)
    const orderStr = settings.sidebar_section_order;
    let baseOrder: string[];
    if (orderStr) {
      baseOrder = orderStr.split(",").filter(Boolean);
    } else if (settings.sidebar_nav_order) {
      const navOrder = settings.sidebar_nav_order.split(",").filter(Boolean);
      baseOrder = [
        ...navOrder,
        ...DEFAULT_SIDEBAR_ORDER.filter((id) => SECTION_IDS.has(id)),
      ];
    } else {
      baseOrder = DEFAULT_SIDEBAR_ORDER;
    }

    const result: string[] = [];
    const seen = new Set<string>();
    for (const id of baseOrder) {
      if (visibleIds.has(id) && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
    for (const id of DEFAULT_SIDEBAR_ORDER) {
      if (visibleIds.has(id) && !seen.has(id)) result.push(id);
    }
    return result;
  }, [
    visibleNavItems, favoriteViewIds, favoriteNavItems.length,
    favoriteProjects.length, projects.length, onOpenProjectModal,
    savedFilters.length, hasToolsContent,
    settings.sidebar_section_order, settings.sidebar_nav_order,
  ]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = [...orderedSidebarItems];
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;
      ids.splice(oldIndex, 1);
      ids.splice(newIndex, 0, active.id as string);
      updateSetting("sidebar_section_order", ids.join(","));
    },
    [orderedSidebarItems, updateSetting],
  );

  const handleNavContextMenu = useCallback(
    (e: ReactMouseEvent, itemId: string) => {
      e.preventDefault();
      setCtxMenu({ itemId, x: e.clientX, y: e.clientY });
    },
    [],
  );

  // Check if any optional views are hidden
  const hasHiddenViews = useMemo(() => {
    return Object.entries(NAV_FEATURE_MAP).some(([, key]) => settings[key] === "false");
  }, [settings]);

  const contextMenuItems = useMemo(() => {
    if (!ctxMenu) return [];
    const { itemId } = ctxMenu;
    const items: Array<{
      id: string;
      label: string;
      icon?: ReactNode;
      separator?: boolean;
      disabled?: boolean;
      onClick?: () => void;
    }> = [];

    // ── Group 1: Favorites ──
    const isFavorited = favoriteViewIds.has(itemId);
    items.push({
      id: "favorite",
      label: isFavorited ? "Remove from Favorites" : "Add to Favorites",
      icon: <Heart size={14} />,
      onClick: () => {
        const current = new Set(favoriteViewIds);
        if (isFavorited) current.delete(itemId);
        else current.add(itemId);
        updateSetting("sidebar_favorite_views", [...current].join(","));
      },
    });

    // ── Group 2: Set as Home ──
    const isHome = settings.start_view === itemId;
    items.push({
      id: "set-home",
      label: isHome ? "Home view" : "Set as Home view",
      icon: <Home size={14} />,
      separator: true,
      disabled: isHome,
      onClick: isHome ? undefined : () => updateSetting("start_view", itemId),
    });

    // Copy link
    items.push({
      id: "copy-link",
      label: "Copy link",
      icon: <Link size={14} />,
      onClick: () => {
        const url = `${window.location.origin}${window.location.pathname}#/${itemId}`;
        navigator.clipboard.writeText(url).catch(() => {});
      },
    });

    // ── Group 3: Visibility ──
    const featureKey = NAV_FEATURE_MAP[itemId];
    if (featureKey && !CORE_VIEWS.has(itemId)) {
      items.push({
        id: "hide",
        label: "Hide from sidebar",
        icon: <EyeOff size={14} />,
        separator: true,
        onClick: () => updateSetting(featureKey, "false"),
      });

      // Hide others — hide all optional views except this one
      const otherOptionalVisible = orderedSidebarItems.filter(
        (id) => id !== itemId && NAV_FEATURE_MAP[id] && !CORE_VIEWS.has(id) && !SECTION_IDS.has(id),
      );
      if (otherOptionalVisible.length > 0) {
        items.push({
          id: "hide-others",
          label: "Hide others",
          icon: <EyeOff size={14} />,
          onClick: () => {
            for (const otherId of otherOptionalVisible) {
              const key = NAV_FEATURE_MAP[otherId];
              if (key) updateSetting(key, "false");
            }
          },
        });
      }
    }

    if (CORE_VIEWS.has(itemId) && onOpenSettings) {
      items.push({
        id: "manage",
        label: "Manage in Settings",
        icon: <Settings size={14} />,
        separator: true,
        onClick: () => onOpenSettings(),
      });
    }

    // Show all hidden
    if (hasHiddenViews) {
      items.push({
        id: "show-all",
        label: "Show all hidden",
        icon: <Eye size={14} />,
        separator: !featureKey && !CORE_VIEWS.has(itemId),
        onClick: () => {
          for (const [, key] of Object.entries(NAV_FEATURE_MAP)) {
            if (settings[key] === "false") updateSetting(key, "true");
          }
        },
      });
    }

    // ── Group 4: Ordering ──
    const currentIndex = orderedSidebarItems.indexOf(itemId);

    if (currentIndex > 0) {
      items.push({
        id: "move-top",
        label: "Move to top",
        icon: <ArrowUpToLine size={14} />,
        separator: true,
        onClick: () => {
          const reordered = orderedSidebarItems.filter((id) => id !== itemId);
          reordered.unshift(itemId);
          updateSetting("sidebar_section_order", reordered.join(","));
        },
      });
    }

    if (currentIndex >= 0 && currentIndex < orderedSidebarItems.length - 1) {
      items.push({
        id: "move-bottom",
        label: "Move to bottom",
        icon: <ArrowDownToLine size={14} />,
        onClick: () => {
          const reordered = orderedSidebarItems.filter((id) => id !== itemId);
          reordered.push(itemId);
          updateSetting("sidebar_section_order", reordered.join(","));
        },
      });
    }

    if (settings.sidebar_section_order || settings.sidebar_nav_order) {
      items.push({
        id: "reset-order",
        label: "Reset order",
        icon: <RotateCcw size={14} />,
        onClick: () => {
          updateSetting("sidebar_section_order", "");
          if (settings.sidebar_nav_order) updateSetting("sidebar_nav_order", "");
        },
      });
    }

    return items;
  }, [ctxMenu, favoriteViewIds, settings, onOpenSettings, orderedSidebarItems, hasHiddenViews, updateSetting]);

  return (
    <aside
      aria-label="Main navigation"
      className={`relative z-20 border-r border-border bg-surface-secondary flex flex-col transition-[width] duration-200 ${
        collapsed ? "w-16 overflow-visible" : "w-sidebar"
      }`}
    >
      {/* ── Header ── */}
      <div className={`py-4 ${collapsed ? "px-2" : "px-4"}`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <img src="/images/logo.svg" alt="Saydo logo" className="w-6 h-6" />
              <h2 className="text-base font-bold text-on-surface tracking-tight">Saydo</h2>
            </div>
          ) : (
            <img src="/images/logo.svg" alt="Saydo logo" className="w-6 h-6" />
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
              <CollapsedTooltip visible={collapsed} label="Expand sidebar" />
            </button>
          )}
        </div>

        {/* ── Add task ── */}
        {onAddTask && (
          <button
            onClick={onAddTask}
            className={`mt-3 w-full flex items-center rounded-lg bg-accent text-white font-medium text-sm transition-colors hover:bg-accent-hover active:scale-[0.98] ${
              collapsed ? "justify-center p-2" : "gap-2 px-3 py-2"
            }`}
          >
            <Plus size={18} />
            {!collapsed && "Add task"}
          </button>
        )}

        {/* ── Search ── */}
        {onSearch && !collapsed && (
          <button
            onClick={onSearch}
            className="mt-2 w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
          >
            <Search size={16} />
            <span className="flex-1 text-left">Search</span>
            <kbd className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-muted border border-border/50">
              {isMac ? "⌘K" : "Ctrl+K"}
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
            <CollapsedTooltip visible={collapsed} label="Search" />
          </button>
        )}
      </div>

      {/* ── Navigation ── */}
      <nav
        aria-label="Views"
        className={`flex-1 flex flex-col min-h-0 ${collapsed ? "px-2" : "px-3"}`}
      >
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide space-y-0.5">
          {/* ── Collapsed mode ── */}
          {collapsed && (
            <>
              {orderedSidebarItems
                .filter((id) => !SECTION_IDS.has(id))
                .map((itemId) => {
                  const item = navItemMap.get(itemId);
                  if (!item) return null;
                  return (
                    <div key={item.id}>
                      {renderNavButton(
                        item.id,
                        item.label,
                        item.icon,
                        currentView === item.id,
                        () => onNavigate(item.id),
                        item.countKey ? countMap[item.countKey] : undefined,
                      )}
                    </div>
                  );
                })}
              {viewsBySlot.navigation.map((view) => (
                <div key={`plugin-view-${view.id}`}>{renderPluginViewButton(view)}</div>
              ))}

              {/* Collapsed Projects */}
              {projects.filter((p) => !p.archived).length > 0 && (
                <div className="space-y-0.5 mt-2">
                  {projects
                    .filter((p) => !p.archived)
                    .slice(0, 5)
                    .map((p) => (
                      <div key={p.id}>
                        <button
                          onClick={() => onNavigate("project", p.id)}
                          title={p.name}
                          aria-current={
                            currentView === "project" && selectedProjectId === p.id ? "page" : undefined
                          }
                          className={`group relative w-full flex items-center justify-center p-1.5 rounded-lg transition-colors ${
                            currentView === "project" && selectedProjectId === p.id
                              ? "bg-accent/10 text-accent"
                              : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                          }`}
                        >
                          {p.icon ? (
                            <span className="text-base leading-none">{p.icon}</span>
                          ) : (
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: p.color }}
                            />
                          )}
                          <CollapsedTooltip visible={collapsed} label={p.name} />
                        </button>
                      </div>
                    ))}
                </div>
              )}

              {/* Collapsed Tools */}
              {viewsBySlot.tools.length > 0 && (
                <div className="space-y-0.5 mt-2">
                  {viewsBySlot.tools.map((view) => {
                    const isActive = currentView === "plugin-view" && selectedPluginViewId === view.id;
                    return (
                      <div key={view.id}>
                        <button
                          onClick={() => onNavigate("plugin-view", view.id)}
                          title={view.name}
                          aria-current={isActive ? "page" : undefined}
                          className={`group relative w-full flex items-center justify-center p-1.5 rounded-lg transition-colors ${
                            isActive
                              ? "bg-accent/10 text-accent"
                              : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                          }`}
                        >
                          <span className="text-base leading-none">{view.icon}</span>
                          <CollapsedTooltip visible={collapsed} label={view.name} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ── Expanded mode: flat sortable list ── */}
          {!collapsed && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={orderedSidebarItems} strategy={verticalListSortingStrategy}>
                {orderedSidebarItems.map((itemId) => {
                  // ── Nav item ──
                  if (!SECTION_IDS.has(itemId)) {
                    const item = navItemMap.get(itemId);
                    if (!item) return null;
                    return (
                      <SortableNavItem key={itemId} id={itemId}>
                        {renderNavButton(
                          item.id,
                          item.label,
                          item.icon,
                          currentView === item.id,
                          () => onNavigate(item.id),
                          item.countKey ? countMap[item.countKey] : undefined,
                          (e) => handleNavContextMenu(e, item.id),
                        )}
                      </SortableNavItem>
                    );
                  }

                  // ── Favorite Views section ──
                  if (itemId === "favorite-views") {
                    return (
                      <SortableSection key={itemId} id={itemId}>
                        {(dragListeners) => (
                          <>
                            <SectionHeader
                              label="Favorite Views"
                              expanded={favoriteViewsExpanded}
                              onToggle={() => setFavoriteViewsExpanded(!favoriteViewsExpanded)}
                              trailing={<Heart size={11} className="text-on-surface-muted mr-1" />}
                              dragHandleListeners={dragListeners}
                            />
                            {favoriteViewsExpanded && (
                              <ul className="space-y-0.5">
                                {favoriteNavItems.map((item) => (
                                  <li key={`fav-${item.id}`}>
                                    {renderNavButton(
                                      `fav-${item.id}`,
                                      item.label,
                                      item.icon,
                                      currentView === item.id,
                                      () => onNavigate(item.id),
                                      item.countKey ? countMap[item.countKey] : undefined,
                                      (e) => handleNavContextMenu(e, item.id),
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </SortableSection>
                    );
                  }

                  // ── Favorites (projects) section ──
                  if (itemId === "favorites") {
                    return (
                      <SortableSection key={itemId} id={itemId}>
                        {(dragListeners) => (
                          <>
                            <SectionHeader
                              label="Favorites"
                              expanded={favoritesExpanded}
                              onToggle={() => setFavoritesExpanded(!favoritesExpanded)}
                              trailing={<Star size={11} className="text-on-surface-muted mr-1" />}
                              dragHandleListeners={dragListeners}
                            />
                            {favoritesExpanded && (
                              <ul className="space-y-0.5">
                                {favoriteProjects.map((project) => (
                                  <li key={project.id}>{renderProjectButton(project)}</li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </SortableSection>
                    );
                  }

                  // ── My Projects section ──
                  if (itemId === "projects") {
                    return (
                      <SortableSection key={itemId} id={itemId}>
                        {(dragListeners) => (
                          <>
                            <SectionHeader
                              label="My Projects"
                              expanded={projectsExpanded}
                              onToggle={() => setProjectsExpanded(!projectsExpanded)}
                              trailing={
                                onOpenProjectModal && projectsExpanded ? (
                                  <button
                                    onClick={onOpenProjectModal}
                                    title="New project"
                                    className="p-0.5 rounded text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
                                  >
                                    <Plus size={14} />
                                  </button>
                                ) : undefined
                              }
                              dragHandleListeners={dragListeners}
                            />
                            {projectsExpanded && (
                              <ul className="space-y-0.5">
                                {projectTree.roots.map((project) => {
                                  const children = projectTree.childrenMap.get(project.id) ?? [];
                                  const hasChildren = children.length > 0;
                                  const isParentExpanded = expandedParents.has(project.id);
                                  return (
                                    <li key={project.id}>
                                      <div className="flex items-center">
                                        {hasChildren && (
                                          <button
                                            onClick={() => toggleParentExpanded(project.id)}
                                            className="p-0.5 mr-0.5 rounded text-on-surface-muted hover:text-on-surface-secondary transition-colors"
                                          >
                                            {isParentExpanded ? (
                                              <ChevronDown size={12} />
                                            ) : (
                                              <ChevronRight size={12} />
                                            )}
                                          </button>
                                        )}
                                        <div className={`flex-1 ${!hasChildren ? "ml-5" : ""}`}>
                                          {renderProjectButton(project)}
                                        </div>
                                      </div>
                                      {hasChildren && isParentExpanded && (
                                        <ul className="ml-4 space-y-0.5">
                                          {children.map((child) => (
                                            <li key={child.id}>{renderProjectButton(child)}</li>
                                          ))}
                                        </ul>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </>
                        )}
                      </SortableSection>
                    );
                  }

                  // ── My Views section ──
                  if (itemId === "my-views") {
                    return (
                      <SortableSection key={itemId} id={itemId}>
                        {(dragListeners) => (
                          <>
                            <SectionHeader
                              label="My Views"
                              expanded={filtersExpanded}
                              onToggle={() => setFiltersExpanded(!filtersExpanded)}
                              dragHandleListeners={dragListeners}
                            />
                            {filtersExpanded && (
                              <ul className="space-y-0.5">
                                {savedFilters.map((filter) => {
                                  const isActive = currentView === "filter" && selectedFilterId === filter.id;
                                  return (
                                    <li key={`filter-${filter.id}`}>
                                      {renderNavButton(
                                        `filter-${filter.id}`,
                                        filter.name,
                                        Filter,
                                        isActive,
                                        () => onNavigate("filter", filter.id),
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </>
                        )}
                      </SortableSection>
                    );
                  }

                  // ── Tools section ──
                  if (itemId === "tools") {
                    return (
                      <SortableSection key={itemId} id={itemId}>
                        {(dragListeners) => (
                          <>
                            <SectionHeader
                              label="Tools"
                              expanded={toolsExpanded}
                              onToggle={() => setToolsExpanded(!toolsExpanded)}
                              dragHandleListeners={dragListeners}
                            />
                            {toolsExpanded && (
                              <>
                                {viewsBySlot.tools.length > 0 && (
                                  <ul className="space-y-0.5">
                                    {viewsBySlot.tools.map((view) => (
                                      <li key={`plugin-view-${view.id}`}>{renderPluginViewButton(view)}</li>
                                    ))}
                                  </ul>
                                )}
                                {panels.length > 0 && (
                                  <div className="space-y-1.5 px-3 mt-1">
                                    {panels.map((panel) => (
                                      <div
                                        key={panel.id}
                                        className="p-2 rounded-md bg-surface-tertiary border border-border"
                                      >
                                        <div className="flex items-center gap-1 text-xs font-medium text-on-surface-secondary mb-1">
                                          <span>{panel.icon}</span>
                                          <span>{panel.title}</span>
                                        </div>
                                        {panel.content && (
                                          <p className="text-xs text-on-surface-muted whitespace-pre-wrap">
                                            {panel.content}
                                          </p>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </>
                        )}
                      </SortableSection>
                    );
                  }

                  return null;
                })}

                {/* Plugin navigation views (not sortable) */}
                {viewsBySlot.navigation.map((view) => (
                  <div key={`plugin-view-${view.id}`}>{renderPluginViewButton(view)}</div>
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* ── Bottom: Workspace ── */}
        <div
          className={`shrink-0 border-t border-border/60 ${collapsed ? "pt-2 pb-3" : "pt-3 pb-3"}`}
        >
          {!collapsed && (
            <h3 className="text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider mb-1 px-3">
              Workspace
            </h3>
          )}
          <ul className="space-y-0.5">
            {viewsBySlot.workspace.map((view) => (
              <li key={`plugin-view-${view.id}`}>{renderPluginViewButton(view)}</li>
            ))}
            <li>
              {renderNavButton("ai-chat", "AI Chat", MessageSquare, currentView === "ai-chat", () =>
                onNavigate("ai-chat"),
              )}
            </li>
            {onOpenSettings && (
              <li>
                <button
                  onClick={onOpenSettings}
                  className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface ${
                    collapsed ? "justify-center" : "gap-3"
                  }`}
                >
                  <Settings size={18} strokeWidth={1.75} />
                  {!collapsed && "Settings"}
                  <CollapsedTooltip visible={collapsed} label="Settings" />
                </button>
              </li>
            )}
          </ul>
        </div>
      </nav>

      {/* ── Nav item context menu ── */}
      {ctxMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  );
}
