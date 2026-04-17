import { type MouseEvent as ReactMouseEvent, type ComponentType, useEffect, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { LucideIcon } from "lucide-react";
import type { Project } from "../../../core/types.js";
import type { PanelInfo, ViewInfo } from "../../api/plugins.js";
import { SECTION_IDS, SortableNavItem, renderNavButton } from "./SidebarPrimitives.js";
import { renderSection } from "./NavSection.js";
import { CollapsedNav } from "./CollapsedNav.js";

interface ViewNavigationProps {
  collapsed: boolean;
  currentView: string;
  selectedProjectId: string | null;
  selectedPluginViewId?: string | null;
  onNavigate: (view: string, id?: string) => void;
  // Items & order
  orderedSidebarItems: string[];
  navItemMap: Map<
    string,
    { id: string; label: string; icon: LucideIcon | string; countKey?: "inbox" | "today" }
  >;
  countMap: Record<string, number | undefined>;
  // Plugin views
  viewsBySlot: { navigation: ViewInfo[]; tools: ViewInfo[]; workspace: ViewInfo[] };
  // Projects
  projects: Project[];
  projectTaskCounts?: Map<string, number>;
  projectCompletedCounts?: Map<string, number>;
  favoriteProjects: Project[];
  // Sections state
  projectsExpanded: boolean;
  setProjectsExpanded: (v: boolean) => void;
  favoritesExpanded: boolean;
  setFavoritesExpanded: (v: boolean) => void;
  toolsExpanded: boolean;
  setToolsExpanded: (v: boolean) => void;
  filtersExpanded: boolean;
  setFiltersExpanded: (v: boolean) => void;
  favoriteViewsExpanded: boolean;
  setFavoriteViewsExpanded: (v: boolean) => void;
  // Favorites
  favoriteNavItems: Array<{
    id: string;
    label: string;
    icon: LucideIcon | string;
    countKey?: "inbox" | "today";
  }>;
  // Filters
  savedFilters: Array<{ id: string; name: string; query: string; color?: string }>;
  selectedFilterId?: string | null;
  // Panels
  panels: PanelInfo[];
  // DnD
  onDragEnd: (event: DragEndEvent) => void;
  // Context menu
  onNavContextMenu: (e: ReactMouseEvent, itemId: string) => void;
  // Projects
  onOpenProjectModal?: () => void;
  onProjectContextMenu?: (e: ReactMouseEvent, project: Project) => void;
}

function ExpandedNavigation(props: ViewNavigationProps) {
  const {
    collapsed,
    currentView,
    selectedProjectId,
    selectedPluginViewId,
    onNavigate,
    orderedSidebarItems,
    navItemMap,
    countMap,
    viewsBySlot,
    projects,
    projectTaskCounts,
    projectCompletedCounts,
    favoriteProjects,
    projectsExpanded,
    setProjectsExpanded,
    favoritesExpanded,
    setFavoritesExpanded,
    toolsExpanded,
    setToolsExpanded,
    filtersExpanded,
    setFiltersExpanded,
    favoriteViewsExpanded,
    setFavoriteViewsExpanded,
    favoriteNavItems,
    savedFilters,
    selectedFilterId,
    panels,
    onNavContextMenu,
    onOpenProjectModal,
    onProjectContextMenu,
  } = props;

  const sectionProps = {
    collapsed,
    currentView,
    selectedProjectId,
    selectedPluginViewId,
    onNavigate,
    countMap,
    viewsBySlot,
    projects,
    projectTaskCounts,
    projectCompletedCounts,
    favoriteProjects,
    projectsExpanded,
    setProjectsExpanded,
    favoritesExpanded,
    setFavoritesExpanded,
    toolsExpanded,
    setToolsExpanded,
    filtersExpanded,
    setFiltersExpanded,
    favoriteViewsExpanded,
    setFavoriteViewsExpanded,
    favoriteNavItems,
    savedFilters,
    selectedFilterId,
    panels,
    onNavContextMenu,
    onOpenProjectModal,
    onProjectContextMenu,
  };

  return (
    <div data-testid="dnd-context">
      <div data-testid="sortable-context">
        {orderedSidebarItems.map((itemId) => {
          if (!SECTION_IDS.has(itemId)) {
            const item = navItemMap.get(itemId);
            if (!item) return null;
            const isPluginView = itemId.startsWith("plugin-view-");
            const pluginViewId = isPluginView ? itemId.replace("plugin-view-", "") : undefined;
            const isActive = isPluginView
              ? currentView === "plugin-view" && selectedPluginViewId === pluginViewId
              : currentView === item.id;
            const navigate = isPluginView
              ? () => onNavigate("plugin-view", pluginViewId)
              : () => onNavigate(item.id);

            return (
              <SortableNavItem key={itemId} id={itemId}>
                {renderNavButton(
                  item.id,
                  item.label,
                  item.icon,
                  isActive,
                  navigate,
                  collapsed,
                  item.countKey ? countMap[item.countKey] : undefined,
                  (e) => onNavContextMenu(e, item.id),
                )}
              </SortableNavItem>
            );
          }

          return renderSection(itemId, sectionProps);
        })}
      </div>
    </div>
  );
}

export function ViewNavigation(props: ViewNavigationProps) {
  const [DndNavigation, setDndNavigation] = useState<ComponentType<ViewNavigationProps> | null>(
    null,
  );
  const [shouldLoadDnd, setShouldLoadDnd] = useState(false);

  const triggerDndLoad = () => {
    if (!props.collapsed) {
      setShouldLoadDnd(true);
    }
  };

  useEffect(() => {
    if (props.collapsed || shouldLoadDnd || DndNavigation) return;

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(
        () => {
          setShouldLoadDnd(true);
        },
        { timeout: 3200 },
      );

      return () => {
        window.cancelIdleCallback(handle);
      };
    }

    const timeoutHandle = globalThis.setTimeout(() => {
      setShouldLoadDnd(true);
    }, 2000);

    return () => {
      globalThis.clearTimeout(timeoutHandle);
    };
  }, [props.collapsed, shouldLoadDnd, DndNavigation]);

  useEffect(() => {
    if (props.collapsed || !shouldLoadDnd || DndNavigation) return;

    let cancelled = false;
    const loadDndNavigation = async () => {
      const module = await import("./ViewNavigationDnd.js");
      if (!cancelled) {
        setDndNavigation(() => module.ViewNavigationDnd);
      }
    };

    void loadDndNavigation();

    return () => {
      cancelled = true;
    };
  }, [props.collapsed, shouldLoadDnd, DndNavigation]);

  if (props.collapsed) {
    return (
      <CollapsedNav
        orderedSidebarItems={props.orderedSidebarItems}
        navItemMap={props.navItemMap}
        countMap={props.countMap}
        currentView={props.currentView}
        selectedProjectId={props.selectedProjectId}
        selectedPluginViewId={props.selectedPluginViewId}
        onNavigate={props.onNavigate}
        onNavContextMenu={props.onNavContextMenu}
        onProjectContextMenu={props.onProjectContextMenu}
        projects={props.projects}
        viewsBySlot={props.viewsBySlot}
        collapsed={props.collapsed}
      />
    );
  }

  if (DndNavigation) {
    return <DndNavigation {...props} />;
  }

  return (
    <div onPointerEnter={triggerDndLoad} onPointerDownCapture={triggerDndLoad}>
      <ExpandedNavigation {...props} />
    </div>
  );
}

export type { ViewNavigationProps };
