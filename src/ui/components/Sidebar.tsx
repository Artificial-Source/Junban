import { useState, useMemo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { Inbox } from "lucide-react";
import type { Project } from "../../core/types.js";
import type { PanelInfo, ViewInfo } from "../api/plugins.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { ContextMenu } from "./ContextMenu.js";
import {
  NAV_ITEMS,
  DEFAULT_SIDEBAR_ORDER,
  SECTION_IDS,
  NAV_FEATURE_MAP,
} from "./sidebar/SidebarPrimitives.js";
import { ViewNavigation } from "./sidebar/ViewNavigation.js";
import {
  useSidebarContextMenu,
  useSidebarEmptyContextMenu,
  type ContextMenuState,
} from "./sidebar/SidebarContextMenu.js";
import { SidebarHeader } from "./sidebar/SidebarHeader.js";
import { WorkspaceSection } from "./sidebar/WorkspaceSection.js";

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
  const [favoriteViewsExpanded, setFavoriteViewsExpanded] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [emptySpaceMenu, setEmptySpaceMenu] = useState<{ x: number; y: number } | null>(null);

  const visibleNavItems = useMemo(() => {
    const hidden = new Set<string>();
    for (const [viewId, settingKey] of Object.entries(NAV_FEATURE_MAP)) {
      if (settings[settingKey] === "false") hidden.add(viewId);
    }
    return NAV_ITEMS.filter((item) => !hidden.has(item.id));
  }, [settings]);

  const favoriteViewIds = useMemo(() => {
    const str = settings.sidebar_favorite_views;
    return str ? new Set(str.split(",").filter(Boolean)) : new Set<string>();
  }, [settings.sidebar_favorite_views]);

  const favoriteNavItems = useMemo(
    () => visibleNavItems.filter((item) => favoriteViewIds.has(item.id)),
    [visibleNavItems, favoriteViewIds],
  );
  const navItemMap = useMemo(() => {
    const map = new Map<
      string,
      { id: string; label: string; icon: typeof Inbox | string; countKey?: "inbox" | "today" }
    >(NAV_ITEMS.map((item) => [item.id, item]));
    for (const view of pluginViews) {
      if (view.slot === "navigation" && !map.has(view.id)) {
        map.set(view.id, { id: view.id, label: view.name, icon: view.icon ?? "🧩" });
      }
    }
    return map;
  }, [pluginViews, builtinPluginIds]);
  const favoriteProjects = useMemo(
    () => projects.filter((p) => p.isFavorite && !p.archived),
    [projects],
  );

  const viewsBySlot = useMemo(() => {
    const navigation: ViewInfo[] = [],
      tools: ViewInfo[] = [],
      workspace: ViewInfo[] = [];
    for (const view of pluginViews) {
      const slot =
        view.slot === "navigation" &&
        builtinPluginIds.has(view.pluginId) &&
        !navItemMap.has(view.id)
          ? "navigation"
          : view.slot === "navigation"
            ? "tools"
            : view.slot;
      if (slot === "navigation") navigation.push(view);
      else if (slot === "workspace") workspace.push(view);
      else tools.push(view);
    }
    return { navigation, tools, workspace };
  }, [pluginViews, builtinPluginIds, navItemMap]);

  const hasToolsContent = viewsBySlot.tools.length > 0 || panels.length > 0;

  const orderedSidebarItems = useMemo(() => {
    const visibleIds = new Set<string>();
    for (const item of visibleNavItems) {
      if (!favoriteViewIds.has(item.id)) visibleIds.add(item.id);
    }
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
      baseOrder = [
        ...settings.sidebar_nav_order.split(",").filter(Boolean),
        ...DEFAULT_SIDEBAR_ORDER.filter((id) => SECTION_IDS.has(id)),
      ];
    } else baseOrder = DEFAULT_SIDEBAR_ORDER;
    const result: string[] = [],
      seen = new Set<string>();
    for (const id of baseOrder) {
      if (visibleIds.has(id) && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
    for (const id of DEFAULT_SIDEBAR_ORDER) {
      if (visibleIds.has(id) && !seen.has(id)) result.push(id);
    }
    for (const view of viewsBySlot.navigation) {
      const viewId = `plugin-view-${view.id}`;
      if (!seen.has(viewId)) {
        result.push(viewId);
        seen.add(viewId);
      }
    }
    return result;
  }, [
    visibleNavItems,
    favoriteViewIds,
    favoriteNavItems.length,
    favoriteProjects.length,
    projects.length,
    onOpenProjectModal,
    savedFilters.length,
    hasToolsContent,
    settings.sidebar_section_order,
    settings.sidebar_nav_order,
    viewsBySlot.navigation,
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

  const handleNavContextMenu = useCallback((e: ReactMouseEvent, itemId: string) => {
    e.preventDefault();
    setEmptySpaceMenu(null);
    setCtxMenu({ itemId, x: e.clientX, y: e.clientY });
  }, []);

  const handleEmptySpaceContextMenu = useCallback((e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a") || target.closest("[role='menuitem']"))
      return;
    e.preventDefault();
    setCtxMenu(null);
    setEmptySpaceMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const hasHiddenViews = useMemo(
    () => Object.entries(NAV_FEATURE_MAP).some(([, key]) => settings[key] === "false"),
    [settings],
  );

  const contextMenuItems = useSidebarContextMenu({
    ctxMenu,
    favoriteViewIds,
    settings,
    updateSetting,
    onOpenSettings,
    orderedSidebarItems,
    hasHiddenViews,
  });

  const emptyContextMenuItems = useSidebarEmptyContextMenu({
    position: emptySpaceMenu,
    onOpenProjectModal,
    onAddTask,
    onOpenSettings,
    settings,
    updateSetting,
  });

  const countMap: Record<string, number | undefined> = { inbox: inboxCount, today: todayCount };

  return (
    <aside
      aria-label="Main navigation"
      className={`relative z-20 border-r border-border bg-surface-secondary flex flex-col transition-[width] duration-200 ease-out motion-reduce:transition-none ${collapsed ? "w-16 overflow-visible" : "w-sidebar"}`}
    >
      <SidebarHeader
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        onAddTask={onAddTask}
        onSearch={onSearch}
      />

      <nav
        aria-label="Views"
        className={`flex-1 flex flex-col min-h-0 ${collapsed ? "px-2" : "px-3"}`}
        onContextMenu={handleEmptySpaceContextMenu}
      >
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide space-y-0.5">
          <ViewNavigation
            collapsed={collapsed}
            currentView={currentView}
            selectedProjectId={selectedProjectId}
            selectedPluginViewId={selectedPluginViewId}
            onNavigate={onNavigate}
            orderedSidebarItems={orderedSidebarItems}
            navItemMap={navItemMap}
            countMap={countMap}
            viewsBySlot={viewsBySlot}
            projects={projects}
            projectTaskCounts={projectTaskCounts}
            projectCompletedCounts={projectCompletedCounts}
            favoriteProjects={favoriteProjects}
            projectsExpanded={projectsExpanded}
            setProjectsExpanded={setProjectsExpanded}
            favoritesExpanded={favoritesExpanded}
            setFavoritesExpanded={setFavoritesExpanded}
            toolsExpanded={toolsExpanded}
            setToolsExpanded={setToolsExpanded}
            filtersExpanded={filtersExpanded}
            setFiltersExpanded={setFiltersExpanded}
            favoriteViewsExpanded={favoriteViewsExpanded}
            setFavoriteViewsExpanded={setFavoriteViewsExpanded}
            favoriteNavItems={favoriteNavItems}
            savedFilters={savedFilters}
            selectedFilterId={selectedFilterId}
            panels={panels}
            onDragEnd={handleDragEnd}
            onNavContextMenu={handleNavContextMenu}
            onOpenProjectModal={onOpenProjectModal}
          />
        </div>

        <WorkspaceSection
          collapsed={collapsed}
          currentView={currentView}
          selectedPluginViewId={selectedPluginViewId}
          workspaceViews={viewsBySlot.workspace}
          onNavigate={onNavigate}
          onOpenSettings={onOpenSettings}
        />
      </nav>

      {ctxMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {emptySpaceMenu && emptyContextMenuItems.length > 0 && (
        <ContextMenu
          items={emptyContextMenuItems}
          position={emptySpaceMenu}
          onClose={() => setEmptySpaceMenu(null)}
        />
      )}
    </aside>
  );
}
