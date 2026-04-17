import type { ReactNode } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { useSensor, useSensors, KeyboardSensor, PointerSensor } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SECTION_IDS, renderNavButton } from "./SidebarPrimitives.js";
import { SortableNavItem, SortableSection } from "./SidebarSortable.js";
import { renderSection } from "./NavSection.js";
import type { ViewNavigationProps } from "./ViewNavigation.js";

export function ViewNavigationDnd({
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
  onDragEnd,
  onNavContextMenu,
  onOpenProjectModal,
  onProjectContextMenu,
}: ViewNavigationProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
    sectionRenderer: ({
      id,
      children,
    }: {
      id: string;
      children: (dragHandleListeners: Record<string, unknown>) => ReactNode;
    }) => (
      <SortableSection key={id} id={id}>
        {(dragListeners) => children(dragListeners)}
      </SortableSection>
    ),
  };

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
