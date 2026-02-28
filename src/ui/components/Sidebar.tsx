import { useState, useMemo } from "react";
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
} from "lucide-react";
import type { Project } from "../../core/types.js";
import type { PanelInfo, ViewInfo } from "../api/index.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

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

function SectionHeader({
  label,
  expanded,
  onToggle,
  trailing,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center mt-5 mb-1 px-3">
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
  const { settings } = useGeneralSettings();
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [toolsExpanded, setToolsExpanded] = useState(true);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

  const visibleNavItems = useMemo(() => {
    const hidden = new Set<string>();
    if (settings.feature_cancelled === "false") hidden.add("cancelled");
    if (settings.feature_stats === "false") hidden.add("stats");
    if (settings.feature_someday === "false") hidden.add("someday");
    if (settings.feature_matrix === "false") hidden.add("matrix");
    return NAV_ITEMS.filter((item) => !hidden.has(item.id));
  }, [settings.feature_cancelled, settings.feature_stats, settings.feature_someday, settings.feature_matrix]);

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
    id: string,
    label: string,
    icon: typeof Inbox | string,
    isActive: boolean,
    onClick: () => void,
    count?: number,
  ) => (
    <li key={id}>
      <button
        onClick={onClick}
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
    </li>
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
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
          {/* Nav items + navigation-slot plugin views */}
          <ul className="space-y-0.5">
            {visibleNavItems.map((item) =>
              renderNavButton(
                item.id,
                item.label,
                item.icon,
                currentView === item.id,
                () => onNavigate(item.id),
                item.countKey ? countMap[item.countKey] : undefined,
              ),
            )}
            {viewsBySlot.navigation.map((view) => renderPluginViewButton(view))}
          </ul>

          {/* ── Collapsed Projects ── */}
          {collapsed && projects.filter((p) => !p.archived).length > 0 && (
            <div className="space-y-0.5 mt-2">
              {projects
                .filter((p) => !p.archived)
                .slice(0, 5)
                .map((p) => (
                  <li key={p.id}>
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
                  </li>
                ))}
            </div>
          )}

          {/* ── Collapsed Tools ── */}
          {collapsed && viewsBySlot.tools.length > 0 && (
            <div className="space-y-0.5 mt-2">
              {viewsBySlot.tools.map((view) => {
                const isActive = currentView === "plugin-view" && selectedPluginViewId === view.id;
                return (
                  <li key={view.id}>
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
                  </li>
                );
              })}
            </div>
          )}

          {/* ── Favorites ── */}
          {!collapsed && favoriteProjects.length > 0 && (
            <>
              <SectionHeader
                label="Favorites"
                expanded={favoritesExpanded}
                onToggle={() => setFavoritesExpanded(!favoritesExpanded)}
                trailing={<Star size={11} className="text-on-surface-muted mr-1" />}
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

          {/* ── My Projects ── */}
          {!collapsed && (projects.length > 0 || onOpenProjectModal) && (
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

          {/* ── My Views (saved filters) ── */}
          {!collapsed && savedFilters.length > 0 && (
            <>
              <SectionHeader
                label="My Views"
                expanded={filtersExpanded}
                onToggle={() => setFiltersExpanded(!filtersExpanded)}
              />
              {filtersExpanded && (
                <ul className="space-y-0.5">
                  {savedFilters.map((filter) => {
                    const isActive = currentView === "filter" && selectedFilterId === filter.id;
                    return renderNavButton(
                      `filter-${filter.id}`,
                      filter.name,
                      Filter,
                      isActive,
                      () => onNavigate("filter", filter.id),
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {/* ── Tools (plugin views + panels) ── */}
          {!collapsed && hasToolsContent && (
            <>
              <SectionHeader
                label="Tools"
                expanded={toolsExpanded}
                onToggle={() => setToolsExpanded(!toolsExpanded)}
              />
              {toolsExpanded && (
                <>
                  {viewsBySlot.tools.length > 0 && (
                    <ul className="space-y-0.5">
                      {viewsBySlot.tools.map((view) => renderPluginViewButton(view))}
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
            {viewsBySlot.workspace.map((view) => renderPluginViewButton(view))}
            {renderNavButton("ai-chat", "AI Chat", MessageSquare, currentView === "ai-chat", () =>
              onNavigate("ai-chat"),
            )}
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
    </aside>
  );
}
