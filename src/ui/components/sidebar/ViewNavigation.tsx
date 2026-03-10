import { type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import type { SensorDescriptor, SensorOptions } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Plus, Star, Heart, Filter, type LucideIcon } from "lucide-react";
import type { Project } from "../../../core/types.js";
import type { PanelInfo, ViewInfo } from "../../api/index.js";
import { PluginErrorBoundary } from "../../views/PluginView.js";
import {
  CollapsedTooltip,
  SECTION_IDS,
  SortableNavItem,
  SortableSection,
  SectionHeader,
  renderNavButton,
} from "./SidebarPrimitives.js";
import { ProjectTree, ProjectButton } from "./ProjectTree.js";

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
  const renderPluginViewButton = (view: ViewInfo) => {
    const isActive = currentView === "plugin-view" && selectedPluginViewId === view.id;
    return renderNavButton(
      `plugin-view-${view.id}`,
      view.name,
      view.icon,
      isActive,
      () => onNavigate("plugin-view", view.id),
      collapsed,
    );
  };

  const renderSection = (itemId: string): ReactNode => {
    if (itemId === "favorite-views") {
      if (favoriteNavItems.length === 0) return null;
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
                        collapsed,
                        item.countKey ? countMap[item.countKey] : undefined,
                        (e) => onNavContextMenu(e, item.id),
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
    if (itemId === "favorites") {
      if (favoriteProjects.length === 0) return null;
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
                    <li key={project.id}>
                      <ProjectButton
                        project={project}
                        isActive={currentView === "project" && selectedProjectId === project.id}
                        onNavigate={onNavigate}
                        projectTaskCounts={projectTaskCounts}
                        projectCompletedCounts={projectCompletedCounts}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </SortableSection>
      );
    }
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
                <ProjectTree
                  projects={projects}
                  currentView={currentView}
                  selectedProjectId={selectedProjectId}
                  onNavigate={onNavigate}
                  projectTaskCounts={projectTaskCounts}
                  projectCompletedCounts={projectCompletedCounts}
                  collapsed={collapsed}
                />
              )}
            </>
          )}
        </SortableSection>
      );
    }
    if (itemId === "my-views") {
      if (savedFilters.length === 0) return null;
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
                          collapsed,
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
    if (itemId === "tools") {
      if (panels.length === 0 && viewsBySlot.tools.length === 0) return null;
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
                          {panel.contentType === "react" && panel.component ? (
                            <PluginErrorBoundary pluginId={panel.id}>
                              <panel.component />
                            </PluginErrorBoundary>
                          ) : panel.content ? (
                            <p className="text-xs text-on-surface-muted whitespace-pre-wrap">
                              {panel.content}
                            </p>
                          ) : null}
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
  };

  if (collapsed) {
    return (
      <>
        {orderedSidebarItems
          .filter((id) => !SECTION_IDS.has(id))
          .map((itemId) => {
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
              <div key={item.id}>
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
              </div>
            );
          })}
        {projects.filter((p) => !p.archived).length > 0 && (
          <div className="space-y-0.5 mt-2">
            {projects
              .filter((p) => !p.archived)
              .slice(0, 5)
              .map((p) => (
                <div key={p.id}>
                  <ProjectButton
                    project={p}
                    isActive={currentView === "project" && selectedProjectId === p.id}
                    onNavigate={onNavigate}
                    collapsed={collapsed}
                  />
                </div>
              ))}
          </div>
        )}
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
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={orderedSidebarItems} strategy={verticalListSortingStrategy}>
        {orderedSidebarItems.map((itemId) => {
          if (!SECTION_IDS.has(itemId)) {
            const item = navItemMap.get(itemId);
            if (!item) return null;
            // Plugin navigation views use plugin-view navigation
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
          return renderSection(itemId);
        })}
      </SortableContext>
    </DndContext>
  );
}
