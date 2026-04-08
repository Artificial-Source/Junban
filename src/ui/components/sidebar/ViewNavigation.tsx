import { type MouseEvent as ReactMouseEvent } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import type { SensorDescriptor, SensorOptions } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
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
  sensors: SensorDescriptor<SensorOptions>[];
  onDragEnd: (event: DragEndEvent) => void;
  // Context menu
  onNavContextMenu: (e: ReactMouseEvent, itemId: string) => void;
  // Projects
  onOpenProjectModal?: () => void;
}

export function ViewNavigation({
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
  sensors,
  onDragEnd,
  onNavContextMenu,
  onOpenProjectModal,
}: ViewNavigationProps) {
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
  };

  if (collapsed) {
    return (
      <CollapsedNav
        orderedSidebarItems={orderedSidebarItems}
        navItemMap={navItemMap}
        countMap={countMap}
        currentView={currentView}
        selectedProjectId={selectedProjectId}
        selectedPluginViewId={selectedPluginViewId}
        onNavigate={onNavigate}
        onNavContextMenu={onNavContextMenu}
        projects={projects}
        viewsBySlot={viewsBySlot}
        collapsed={collapsed}
      />
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={orderedSidebarItems} strategy={verticalListSortingStrategy}>
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
      </SortableContext>
    </DndContext>
  );
}
