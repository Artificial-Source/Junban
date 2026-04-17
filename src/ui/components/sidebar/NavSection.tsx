import { type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { Plus, Star, Heart, Filter, type LucideIcon } from "lucide-react";
import type { Project } from "../../../core/types.js";
import type { PanelInfo, ViewInfo } from "../../api/plugins.js";
import { PluginErrorBoundary } from "./PluginErrorBoundary.js";
import { SortableSection, SectionHeader, renderNavButton } from "./SidebarPrimitives.js";
import { ProjectTree, ProjectButton } from "./ProjectTree.js";

type SectionRenderer = (params: {
  id: string;
  children: (dragHandleListeners: Record<string, unknown>) => ReactNode;
}) => ReactNode;

const defaultSectionRenderer: SectionRenderer = ({ id, children }) => (
  <SortableSection key={id} id={id}>
    {(dragListeners) => children(dragListeners)}
  </SortableSection>
);

interface NavSectionRenderProps {
  collapsed: boolean;
  currentView: string;
  selectedProjectId: string | null;
  selectedPluginViewId?: string | null;
  onNavigate: (view: string, id?: string) => void;
  countMap: Record<string, number | undefined>;
  viewsBySlot: { navigation: ViewInfo[]; tools: ViewInfo[]; workspace: ViewInfo[] };
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
  // Context menu
  onNavContextMenu: (e: ReactMouseEvent, itemId: string) => void;
  // Projects
  onOpenProjectModal?: () => void;
  onProjectContextMenu?: (e: ReactMouseEvent, project: Project) => void;
  sectionRenderer?: SectionRenderer;
}

function renderPluginViewButton(
  view: ViewInfo,
  currentView: string,
  selectedPluginViewId: string | null | undefined,
  onNavigate: (view: string, id?: string) => void,
  collapsed: boolean,
) {
  const isActive = currentView === "plugin-view" && selectedPluginViewId === view.id;
  return renderNavButton(
    `plugin-view-${view.id}`,
    view.name,
    view.icon,
    isActive,
    () => onNavigate("plugin-view", view.id),
    collapsed,
  );
}

/** Renders a single sidebar section by its ID. Returns null for unknown section IDs. */
export function renderSection(itemId: string, props: NavSectionRenderProps): ReactNode {
  const {
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
    sectionRenderer = defaultSectionRenderer,
  } = props;

  if (itemId === "favorite-views") {
    if (favoriteNavItems.length === 0) return null;
    return sectionRenderer({
      id: itemId,
      children: (dragListeners) => (
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
      ),
    });
  }
  if (itemId === "favorites") {
    if (favoriteProjects.length === 0) return null;
    return sectionRenderer({
      id: itemId,
      children: (dragListeners) => (
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
                    onContextMenu={onProjectContextMenu}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ),
    });
  }
  if (itemId === "projects") {
    return sectionRenderer({
      id: itemId,
      children: (dragListeners) => (
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
              onContextMenu={onProjectContextMenu}
            />
          )}
        </>
      ),
    });
  }
  if (itemId === "my-views") {
    if (savedFilters.length === 0) return null;
    return sectionRenderer({
      id: itemId,
      children: (dragListeners) => (
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
      ),
    });
  }
  if (itemId === "tools") {
    if (panels.length === 0 && viewsBySlot.tools.length === 0) return null;
    return sectionRenderer({
      id: itemId,
      children: (dragListeners) => (
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
                    <li key={`plugin-view-${view.id}`}>
                      {renderPluginViewButton(
                        view,
                        currentView,
                        selectedPluginViewId,
                        onNavigate,
                        collapsed,
                      )}
                    </li>
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
                        <PluginErrorBoundary pluginId={panel.pluginId}>
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
      ),
    });
  }
  return null;
}
