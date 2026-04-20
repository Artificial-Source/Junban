import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { FolderPlus, Inbox, Pencil, Star, Trash2 } from "lucide-react";
import type { Project } from "../../core/types.js";
import type { PanelInfo, ViewInfo } from "../api/plugins.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { ContextMenu } from "./ContextMenu.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { AddProjectModal } from "./AddProjectModal.js";
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
  onCreateProject?: (
    name: string,
    color: string,
    icon: string,
    parentId: string | null,
    isFavorite: boolean,
    viewStyle: "list" | "board" | "calendar",
  ) => void;
  onUpdateProject?: (
    id: string,
    name: string,
    color: string,
    icon: string,
    parentId: string | null,
    isFavorite: boolean,
    viewStyle: "list" | "board" | "calendar",
  ) => void;
  onDeleteProject?: (id: string) => void;
  builtinPluginIds?: Set<string>;
  savedFilters?: Array<{ id: string; name: string; query: string; color?: string }>;
  selectedFilterId?: string | null;
  mutationsBlocked?: boolean;
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
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  builtinPluginIds = new Set(),
  savedFilters = [],
  selectedFilterId,
  mutationsBlocked = false,
}: SidebarProps) {
  const { settings, updateSetting } = useGeneralSettings();
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [toolsExpanded, setToolsExpanded] = useState(true);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [favoriteViewsExpanded, setFavoriteViewsExpanded] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [emptySpaceMenu, setEmptySpaceMenu] = useState<{ x: number; y: number } | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{
    project: Project;
    x: number;
    y: number;
  } | null>(null);
  const [projectModalState, setProjectModalState] = useState<
    { mode: "create"; defaultParentId: string | null } | { mode: "edit"; project: Project } | null
  >(null);
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);

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
  }, [pluginViews]);
  const favoriteProjects = useMemo(
    () => projects.filter((p) => p.isFavorite && !p.archived),
    [projects],
  );
  const projectsForSidebar = useMemo(() => {
    const activeProjects = projects.filter((p) => !p.archived);
    if (favoriteProjects.length === 0) return activeProjects;
    return activeProjects.filter((p) => !p.isFavorite);
  }, [projects, favoriteProjects]);

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
    if (projectsForSidebar.length > 0 || onOpenProjectModal) visibleIds.add("projects");
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
    projectsForSidebar.length,
    onOpenProjectModal,
    savedFilters.length,
    hasToolsContent,
    settings.sidebar_section_order,
    settings.sidebar_nav_order,
    viewsBySlot.navigation,
  ]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      // Block drag-reorder persistence while mutations are blocked (remote lock)
      if (mutationsBlocked) {
        return;
      }
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
    [orderedSidebarItems, updateSetting, mutationsBlocked],
  );

  const handleNavContextMenu = useCallback((e: ReactMouseEvent, itemId: string) => {
    e.preventDefault();
    setEmptySpaceMenu(null);
    setProjectContextMenu(null);
    setCtxMenu({ itemId, x: e.clientX, y: e.clientY });
  }, []);

  const handleProjectContextMenu = useCallback((e: ReactMouseEvent, project: Project) => {
    e.preventDefault();
    setCtxMenu(null);
    setEmptySpaceMenu(null);
    setProjectContextMenu({ project, x: e.clientX, y: e.clientY });
  }, []);

  const handleEmptySpaceContextMenu = useCallback((e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a") || target.closest("[role='menuitem']"))
      return;
    e.preventDefault();
    setCtxMenu(null);
    setProjectContextMenu(null);
    setEmptySpaceMenu({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    if (!mutationsBlocked) {
      return;
    }

    setProjectModalState(null);
    setProjectDeleteTarget(null);
    setProjectContextMenu(null);
    setEmptySpaceMenu(null);
  }, [mutationsBlocked]);

  const projectContextMenuItems = useMemo(() => {
    if (!projectContextMenu) return [];

    const { project } = projectContextMenu;
    return [
      {
        id: "edit-project",
        label: "Edit project",
        icon: <Pencil size={14} />,
        disabled: mutationsBlocked,
        onClick: mutationsBlocked
          ? undefined
          : () => setProjectModalState({ mode: "edit", project }),
      },
      {
        id: "new-subproject",
        label: "New subproject",
        icon: <FolderPlus size={14} />,
        separator: true,
        disabled: mutationsBlocked,
        onClick: mutationsBlocked
          ? undefined
          : () => setProjectModalState({ mode: "create", defaultParentId: project.id }),
      },
      {
        id: "toggle-favorite",
        label: project.isFavorite ? "Remove from Favorites" : "Add to Favorites",
        icon: <Star size={14} />,
        disabled: mutationsBlocked,
        onClick: mutationsBlocked
          ? undefined
          : () =>
              onUpdateProject?.(
                project.id,
                project.name,
                project.color,
                project.icon ?? "",
                project.parentId,
                !project.isFavorite,
                project.viewStyle,
              ),
      },
      {
        id: "delete-project",
        label: "Delete project",
        icon: <Trash2 size={14} />,
        separator: true,
        danger: true,
        disabled: mutationsBlocked,
        onClick: mutationsBlocked ? undefined : () => setProjectDeleteTarget(project),
      },
    ];
  }, [projectContextMenu, onUpdateProject, mutationsBlocked]);

  const handleProjectModalSubmit = useCallback(
    (
      name: string,
      color: string,
      icon: string,
      parentId: string | null,
      isFavorite: boolean,
      viewStyle: "list" | "board" | "calendar",
    ) => {
      if (projectModalState?.mode === "edit") {
        onUpdateProject?.(
          projectModalState.project.id,
          name,
          color,
          icon,
          parentId,
          isFavorite,
          viewStyle,
        );
        return;
      }

      onCreateProject?.(name, color, icon, parentId, isFavorite, viewStyle);
    },
    [projectModalState, onCreateProject, onUpdateProject],
  );

  const handleConfirmDeleteProject = useCallback(() => {
    if (!projectDeleteTarget) return;
    onDeleteProject?.(projectDeleteTarget.id);
    setProjectDeleteTarget(null);
  }, [projectDeleteTarget, onDeleteProject]);

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
    mutationsBlocked,
  });

  const emptyContextMenuItems = useSidebarEmptyContextMenu({
    position: emptySpaceMenu,
    onOpenProjectModal,
    onAddTask,
    onOpenSettings,
    addActionsDisabled: mutationsBlocked,
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
        addTaskDisabled={mutationsBlocked}
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
            projects={projectsForSidebar}
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
            onProjectContextMenu={handleProjectContextMenu}
            projectActionsDisabled={mutationsBlocked}
            disablePanelInteractions={mutationsBlocked}
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
      {projectContextMenu && projectContextMenuItems.length > 0 && (
        <ContextMenu
          items={projectContextMenuItems}
          position={{ x: projectContextMenu.x, y: projectContextMenu.y }}
          onClose={() => setProjectContextMenu(null)}
        />
      )}
      {emptySpaceMenu && emptyContextMenuItems.length > 0 && (
        <ContextMenu
          items={emptyContextMenuItems}
          position={emptySpaceMenu}
          onClose={() => setEmptySpaceMenu(null)}
        />
      )}
      {projectModalState && (
        <AddProjectModal
          open={true}
          onClose={() => setProjectModalState(null)}
          mode={projectModalState.mode}
          onSubmit={handleProjectModalSubmit}
          projects={projects}
          initialProject={projectModalState.mode === "edit" ? projectModalState.project : null}
          defaultParentId={
            projectModalState.mode === "create" ? projectModalState.defaultParentId : null
          }
        />
      )}
      <ConfirmDialog
        open={projectDeleteTarget !== null}
        title="Delete project?"
        message={
          projectDeleteTarget ? `Delete "${projectDeleteTarget.name}"? This cannot be undone.` : ""
        }
        confirmLabel="Delete"
        onConfirm={handleConfirmDeleteProject}
        onCancel={() => setProjectDeleteTarget(null)}
      />
    </aside>
  );
}
