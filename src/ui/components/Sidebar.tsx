import { useState, useMemo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { motion } from "framer-motion";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { ChevronLeft, ChevronRight, Inbox, Plus, Search, Settings, MessageSquare } from "lucide-react";
import { useReducedMotion } from "./useReducedMotion.js";
import { springGentle } from "../utils/animation-variants.js";
import type { Project } from "../../core/types.js";
import type { PanelInfo, ViewInfo } from "../api/index.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { ContextMenu } from "./ContextMenu.js";
import {
  CollapsedTooltip,
  NAV_ITEMS,
  DEFAULT_SIDEBAR_ORDER,
  SECTION_IDS,
  NAV_FEATURE_MAP,
  renderNavButton,
} from "./sidebar/SidebarPrimitives.js";
import { ViewNavigation } from "./sidebar/ViewNavigation.js";
import { useSidebarContextMenu, useSidebarEmptyContextMenu, type ContextMenuState } from "./sidebar/SidebarContextMenu.js";

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

export function Sidebar({
  currentView, onNavigate, onOpenSettings, projects, selectedProjectId,
  panels = [], pluginViews = [], selectedPluginViewId,
  collapsed = false, onToggleCollapsed,
  projectTaskCounts, projectCompletedCounts,
  onAddTask, onSearch, inboxCount, todayCount,
  onOpenProjectModal, builtinPluginIds = new Set(),
  savedFilters = [], selectedFilterId,
}: SidebarProps) {
  const { settings, updateSetting } = useGeneralSettings();
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [toolsExpanded, setToolsExpanded] = useState(true);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [favoriteViewsExpanded, setFavoriteViewsExpanded] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [emptySpaceMenu, setEmptySpaceMenu] = useState<{ x: number; y: number } | null>(null);

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
    settings.feature_cancelled, settings.feature_stats, settings.feature_someday,
    settings.feature_matrix, settings.feature_calendar, settings.feature_filters_labels,
    settings.feature_completed,
  ]);

  const favoriteViewIds = useMemo(() => {
    const str = settings.sidebar_favorite_views;
    return str ? new Set(str.split(",").filter(Boolean)) : new Set<string>();
  }, [settings.sidebar_favorite_views]);

  const favoriteNavItems = useMemo(
    () => visibleNavItems.filter((item) => favoriteViewIds.has(item.id)),
    [visibleNavItems, favoriteViewIds],
  );
  const navItemMap = useMemo(() => {
    const map = new Map<string, { id: string; label: string; icon: typeof Inbox | string; countKey?: "inbox" | "today" }>(
      NAV_ITEMS.map((item) => [item.id, item]),
    );
    // Include builtin plugin navigation views so they're sortable in the sidebar
    for (const view of pluginViews) {
      if (view.slot === "navigation" && builtinPluginIds.has(view.pluginId)) {
        const viewId = `plugin-view-${view.id}`;
        map.set(viewId, { id: viewId, label: view.name, icon: view.icon ?? "🧩" });
      }
    }
    return map;
  }, [pluginViews, builtinPluginIds]);
  const favoriteProjects = useMemo(() => projects.filter((p) => p.isFavorite && !p.archived), [projects]);

  const viewsBySlot = useMemo(() => {
    const navigation: ViewInfo[] = [], tools: ViewInfo[] = [], workspace: ViewInfo[] = [];
    for (const view of pluginViews) {
      const slot = view.slot === "navigation" && builtinPluginIds.has(view.pluginId) ? "navigation"
        : view.slot === "navigation" ? "tools" : view.slot;
      if (slot === "navigation") navigation.push(view);
      else if (slot === "workspace") workspace.push(view);
      else tools.push(view);
    }
    return { navigation, tools, workspace };
  }, [pluginViews, builtinPluginIds]);

  const hasToolsContent = viewsBySlot.tools.length > 0 || panels.length > 0;

  const orderedSidebarItems = useMemo(() => {
    const visibleIds = new Set<string>();
    for (const item of visibleNavItems) { if (!favoriteViewIds.has(item.id)) visibleIds.add(item.id); }
    // Include builtin plugin navigation views as sortable sidebar items
    for (const view of viewsBySlot.navigation) {
      visibleIds.add(`plugin-view-${view.id}`);
    }
    if (favoriteNavItems.length > 0) visibleIds.add("favorite-views");
    if (favoriteProjects.length > 0) visibleIds.add("favorites");
    if (projects.length > 0 || onOpenProjectModal) visibleIds.add("projects");
    if (savedFilters.length > 0) visibleIds.add("my-views");
    if (hasToolsContent) visibleIds.add("tools");
    const orderStr = settings.sidebar_section_order;
    let baseOrder: string[];
    if (orderStr) baseOrder = orderStr.split(",").filter(Boolean);
    else if (settings.sidebar_nav_order) {
      baseOrder = [...settings.sidebar_nav_order.split(",").filter(Boolean),
        ...DEFAULT_SIDEBAR_ORDER.filter((id) => SECTION_IDS.has(id))];
    } else baseOrder = DEFAULT_SIDEBAR_ORDER;
    const result: string[] = [], seen = new Set<string>();
    for (const id of baseOrder) { if (visibleIds.has(id) && !seen.has(id)) { result.push(id); seen.add(id); } }
    for (const id of DEFAULT_SIDEBAR_ORDER) { if (visibleIds.has(id) && !seen.has(id)) result.push(id); }
    // Append plugin navigation views not yet in the saved order
    for (const view of viewsBySlot.navigation) {
      const viewId = `plugin-view-${view.id}`;
      if (!seen.has(viewId)) { result.push(viewId); seen.add(viewId); }
    }
    return result;
  }, [
    visibleNavItems, favoriteViewIds, favoriteNavItems.length, favoriteProjects.length,
    projects.length, onOpenProjectModal, savedFilters.length, hasToolsContent,
    settings.sidebar_section_order, settings.sidebar_nav_order, viewsBySlot.navigation,
  ]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = [...orderedSidebarItems];
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    ids.splice(oldIndex, 1);
    ids.splice(newIndex, 0, active.id as string);
    updateSetting("sidebar_section_order", ids.join(","));
  }, [orderedSidebarItems, updateSetting]);

  const handleNavContextMenu = useCallback((e: ReactMouseEvent, itemId: string) => {
    e.preventDefault();
    setEmptySpaceMenu(null);
    setCtxMenu({ itemId, x: e.clientX, y: e.clientY });
  }, []);

  const handleEmptySpaceContextMenu = useCallback((e: ReactMouseEvent) => {
    // Only trigger if clicking empty space, not on a button or interactive element
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a") || target.closest("[role='menuitem']")) return;
    e.preventDefault();
    setCtxMenu(null);
    setEmptySpaceMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const hasHiddenViews = useMemo(
    () => Object.entries(NAV_FEATURE_MAP).some(([, key]) => settings[key] === "false"),
    [settings],
  );

  const contextMenuItems = useSidebarContextMenu({
    ctxMenu, favoriteViewIds, settings, updateSetting,
    onOpenSettings, orderedSidebarItems, hasHiddenViews,
  });

  const emptyContextMenuItems = useSidebarEmptyContextMenu({
    position: emptySpaceMenu,
    onOpenProjectModal,
    onAddTask,
    onOpenSettings,
    settings,
    updateSetting,
  });

  const reducedMotion = useReducedMotion();
  const countMap: Record<string, number | undefined> = { inbox: inboxCount, today: todayCount };
  const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

  const SidebarTag = reducedMotion ? "aside" : motion.aside;
  const sidebarMotionProps = reducedMotion
    ? {}
    : { layout: true as const, transition: springGentle };

  return (
    <SidebarTag aria-label="Main navigation"
      className={`relative z-20 border-r border-border bg-surface-secondary flex flex-col ${
        reducedMotion ? "transition-[width] duration-200 " : ""}${
        collapsed ? "w-16 overflow-visible" : "w-sidebar"}`}
      {...sidebarMotionProps}>
      {/* Header */}
      <div className={`py-4 ${collapsed ? "px-2" : "px-4"}`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <img src="/images/logo.svg" alt="Saydo logo" className="w-6 h-6" />
              <h2 className="text-base font-bold text-on-surface tracking-tight">Saydo</h2>
            </div>
          ) : <img src="/images/logo.svg" alt="Saydo logo" className="w-6 h-6" />}
          {onToggleCollapsed && !collapsed && (
            <button onClick={onToggleCollapsed} aria-label="Collapse sidebar"
              className="p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors">
              <ChevronLeft size={16} /></button>
          )}
          {onToggleCollapsed && collapsed && (
            <button onClick={onToggleCollapsed} aria-label="Expand sidebar"
              className="group relative mt-2 p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors">
              <ChevronRight size={16} /><CollapsedTooltip visible label="Expand sidebar" /></button>
          )}
        </div>
        {onAddTask && (
          <motion.button onClick={onAddTask}
            whileHover={reducedMotion ? undefined : { scale: 1.02 }}
            whileTap={reducedMotion ? undefined : { scale: 0.98 }}
            className={`mt-3 w-full flex items-center rounded-lg bg-accent text-white font-medium text-sm transition-colors hover:bg-accent-hover ${
              collapsed ? "justify-center p-2" : "gap-2 px-3 py-2"}`}>
            <Plus size={18} />{!collapsed && "Add task"}</motion.button>
        )}
        {onSearch && !collapsed && (
          <button onClick={onSearch}
            className="mt-2 w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors">
            <Search size={16} /><span className="flex-1 text-left">Search</span>
            <kbd className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-muted border border-border/50">
              {isMac ? "⌘K" : "Ctrl+K"}</kbd></button>
        )}
        {onSearch && collapsed && (
          <button onClick={onSearch} aria-label="Search"
            className="group relative mt-2 w-full flex items-center justify-center p-2 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors">
            <Search size={16} /><CollapsedTooltip visible label="Search" /></button>
        )}
      </div>

      {/* Navigation */}
      <nav aria-label="Views" className={`flex-1 flex flex-col min-h-0 ${collapsed ? "px-2" : "px-3"}`}
        onContextMenu={handleEmptySpaceContextMenu}>
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide space-y-0.5">
          <ViewNavigation
            collapsed={collapsed} currentView={currentView}
            selectedProjectId={selectedProjectId} selectedPluginViewId={selectedPluginViewId}
            onNavigate={onNavigate} orderedSidebarItems={orderedSidebarItems}
            navItemMap={navItemMap} countMap={countMap} viewsBySlot={viewsBySlot}
            projects={projects} projectTaskCounts={projectTaskCounts}
            projectCompletedCounts={projectCompletedCounts} favoriteProjects={favoriteProjects}
            projectsExpanded={projectsExpanded} setProjectsExpanded={setProjectsExpanded}
            favoritesExpanded={favoritesExpanded} setFavoritesExpanded={setFavoritesExpanded}
            toolsExpanded={toolsExpanded} setToolsExpanded={setToolsExpanded}
            filtersExpanded={filtersExpanded} setFiltersExpanded={setFiltersExpanded}
            favoriteViewsExpanded={favoriteViewsExpanded} setFavoriteViewsExpanded={setFavoriteViewsExpanded}
            favoriteNavItems={favoriteNavItems} savedFilters={savedFilters}
            selectedFilterId={selectedFilterId} panels={panels}
            sensors={sensors} onDragEnd={handleDragEnd}
            onNavContextMenu={handleNavContextMenu} onOpenProjectModal={onOpenProjectModal}
          />
        </div>

        {/* Workspace */}
        <div className={`shrink-0 border-t border-border/60 ${collapsed ? "pt-2 pb-3" : "pt-3 pb-3"}`}>
          {!collapsed && (
            <h3 className="text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider mb-1 px-3">Workspace</h3>
          )}
          <ul className="space-y-0.5">
            {viewsBySlot.workspace.map((view) => {
              const isActive = currentView === "plugin-view" && selectedPluginViewId === view.id;
              return <li key={`plugin-view-${view.id}`}>{renderNavButton(`plugin-view-${view.id}`, view.name,
                view.icon, isActive, () => onNavigate("plugin-view", view.id), collapsed)}</li>;
            })}
            <li>{renderNavButton("ai-chat", "AI Chat", MessageSquare, currentView === "ai-chat",
              () => onNavigate("ai-chat"), collapsed)}</li>
            {onOpenSettings && (
              <li>
                <button onClick={onOpenSettings}
                  className={`group relative w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface ${
                    collapsed ? "justify-center" : "gap-3"}`}>
                  <Settings size={18} strokeWidth={1.75} />{!collapsed && "Settings"}
                  <CollapsedTooltip visible={collapsed} label="Settings" /></button>
              </li>
            )}
          </ul>
        </div>
      </nav>

      {ctxMenu && contextMenuItems.length > 0 && (
        <ContextMenu items={contextMenuItems} position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)} />
      )}
      {emptySpaceMenu && emptyContextMenuItems.length > 0 && (
        <ContextMenu items={emptyContextMenuItems} position={emptySpaceMenu}
          onClose={() => setEmptySpaceMenu(null)} />
      )}
    </SidebarTag>
  );
}
