/**
 * Sidebar: full navigation, project tree, saved filters, Phase 3 tools, workspace chrome.
 * Phase 3 authority places Calendar/Matrix/Stats/Timeblocking after projects and keeps a
 * non-functional Workspace footer (AI Chat / Settings) matching the frozen legacy shell.
 * Filters & Labels and Quick Wins remain reachable via routes/command palette; they are
 * omitted from the primary tool strip so the Phase 3 visual authority chrome matches.
 */
import { useState, useMemo, type ComponentType } from "react";
import {
  Inbox,
  CalendarDays,
  Clock,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Plus,
  Search,
  CalendarRange,
  Compass,
  BarChart3,
  CalendarClock,
  MessageSquare,
  Settings,
} from "lucide-react";
import type { View, AppRoute } from "../hooks/useRouting";
import type { CatalogResponse, ProjectDto, SavedFilterDto } from "../api/client";

interface NavItem {
  id: View;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  countKey?: "inbox" | "today";
}

const NAV_ITEMS: NavItem[] = [
  { id: "inbox", label: "Inbox", icon: Inbox, countKey: "inbox" },
  { id: "today", label: "Today", icon: CalendarDays, countKey: "today" },
  { id: "upcoming", label: "Upcoming", icon: Clock },
];

const PHASE_2_NAV_ITEMS: NavItem[] = [
  ...NAV_ITEMS,
  { id: "filters-labels", label: "Filters & Labels", icon: SlidersHorizontal },
];

/** First-party Phase 3 tools — after projects, matching legacy plugin slot order. */
const TOOL_NAV_ITEMS: NavItem[] = [
  { id: "calendar", label: "Calendar", icon: CalendarRange },
  { id: "matrix", label: "Matrix", icon: Compass },
  { id: "stats", label: "Stats", icon: BarChart3 },
  { id: "timeblocking", label: "Timeblocking", icon: CalendarClock },
];

interface SidebarProps {
  currentView: View;
  currentRoute: AppRoute;
  onNavigate: (target: View | AppRoute) => void;
  onAddTask: () => void;
  onSearch: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  catalog: CatalogResponse | null;
  /** Omit when a real count is unavailable — never pass a fabricated zero. */
  inboxCount?: number;
  todayCount?: number;
  onOpenProjectModal: () => void;
  /** Render only the immutable Phase 2 visual authority chrome. */
  phase2VisualFixture?: boolean;
  /** Align explicit Phase 3 evidence with the legacy plugin row gutter. */
  phase3VisualFixture?: boolean;
}

export function Sidebar({
  currentView,
  currentRoute,
  onNavigate,
  onAddTask,
  onSearch,
  collapsed,
  onToggleCollapsed,
  catalog,
  inboxCount,
  todayCount,
  onOpenProjectModal,
  phase2VisualFixture = false,
  phase3VisualFixture = false,
}: SidebarProps) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  // Labels only — matching accelerator lives in useChord (Meta on Apple, Control elsewhere).
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  const countMap: Record<string, number | undefined> = {
    inbox: inboxCount,
    today: todayCount,
  };

  const projects = useMemo(
    () =>
      (catalog?.projects ?? [])
        .filter((p) => !p.archived)
        .sort((a, b) => a.sort_order - b.sort_order),
    [catalog],
  );

  const savedFilters = useMemo(
    () => (catalog?.saved_filters ?? []).sort((a, b) => a.sort_order - b.sort_order),
    [catalog],
  );

  // Build a project tree from flat list.
  const projectTree = useMemo(() => {
    const byParent = new Map<string | null, ProjectDto[]>();
    for (const p of projects) {
      const parentKey = p.parent_id ?? null;
      const list = byParent.get(parentKey) ?? [];
      list.push(p);
      byParent.set(parentKey, list);
    }
    return byParent;
  }, [projects]);

  function renderProjectNode(project: ProjectDto, depth: number): React.ReactNode {
    const isActive = currentRoute.name === "project" && currentRoute.projectId === project.id;
    const children = projectTree.get(project.id) ?? [];

    return (
      <li key={project.id}>
        <button
          onClick={() =>
            onNavigate({
              name: "project",
              projectId: project.id,
              layout:
                project.view === "board"
                  ? "board"
                  : project.view === "calendar"
                    ? "calendar"
                    : "list",
            })
          }
          aria-current={isActive ? "page" : undefined}
          className={`group relative w-full text-left py-1.5 rounded-md text-sm flex items-center transition-colors ${
            collapsed ? "justify-center px-2" : "gap-2 px-3"
          } ${
            isActive
              ? "bg-accent-action/10 text-accent-foreground font-medium"
              : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
          }`}
          style={
            collapsed
              ? undefined
              : {
                  paddingLeft: `${(phase3VisualFixture ? 2.125 : 0.75) + depth * 0.75}rem`,
                }
          }
          title={collapsed ? project.name : undefined}
        >
          {project.color && (
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: project.color }}
            />
          )}
          {!collapsed && <span className="flex-1 truncate">{project.name}</span>}
          {collapsed && (
            <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-on-surface opacity-0 shadow-md transition-opacity group-hover:opacity-100">
              {project.name}
            </span>
          )}
        </button>
        {children.length > 0 && !collapsed && (
          <ul className="space-y-0.5">
            {children.map((child) => renderProjectNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  const rootProjects = projectTree.get(null) ?? [];

  return (
    <aside
      aria-label="Main navigation"
      className={`relative z-20 h-full min-h-0 max-h-full max-w-full border-r border-border bg-surface-secondary flex flex-col transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        collapsed ? "w-16 overflow-visible" : "w-sidebar overflow-y-auto overflow-x-hidden"
      }`}
    >
      {/* Header */}
      <div className={`shrink-0 py-4 ${collapsed ? "px-2" : "px-4"}`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <img
                src="/images/logo.svg"
                alt="Junban logo"
                className="h-7 w-7 shrink-0 rounded-md ring-1 ring-border/60 bg-white object-contain p-1"
              />
              <h2 className="text-base font-bold text-on-surface tracking-tight">Junban</h2>
            </div>
          ) : (
            <img
              src="/images/logo.svg"
              alt="Junban logo"
              className="h-7 w-7 shrink-0 rounded-md ring-1 ring-border/60 bg-white object-contain p-1"
            />
          )}
          {onToggleCollapsed && !collapsed && (
            <button
              onClick={onToggleCollapsed}
              aria-label="Collapse sidebar"
              className="p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ChevronLeft size={16} />
            </button>
          )}
          {onToggleCollapsed && collapsed && (
            <button
              onClick={onToggleCollapsed}
              aria-label="Expand sidebar"
              className="mt-2 p-1.5 rounded-md text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ChevronRight size={16} />
            </button>
          )}
        </div>
        <button
          onClick={onAddTask}
          className={`mt-3 w-full flex items-center rounded-lg bg-accent-action text-on-accent-action font-medium text-sm transition-colors hover:bg-accent-action-hover ${
            collapsed ? "justify-center p-2" : "gap-2 px-3 py-2"
          }`}
        >
          <Plus size={18} />
          {!collapsed && "Add task"}
        </button>
        <button
          onClick={onSearch}
          className={`mt-2 w-full flex items-center rounded-md text-sm text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors ${
            collapsed ? "justify-center p-2" : "gap-2 px-3 py-1.5"
          }`}
        >
          <Search size={16} />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-muted border border-border/50">
                {isMac ? "\u2318K" : "Ctrl+K"}
              </kbd>
            </>
          )}
        </button>
      </div>

      <nav
        aria-label="Views"
        className={`flex-1 shrink-0 flex flex-col ${collapsed ? "px-2" : "px-3"}`}
      >
        <div className="flex-1 shrink-0 scrollbar-hide space-y-0.5">
          {(phase2VisualFixture ? PHASE_2_NAV_ITEMS : NAV_ITEMS).map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            const count = item.countKey ? countMap[item.countKey] : undefined;
            const showCount = typeof count === "number" && count > 0;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={isActive ? "page" : undefined}
                className={`group relative text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors ${
                  phase3VisualFixture && !collapsed ? "ml-[26px] w-[calc(100%-26px)]" : "w-full"
                } ${collapsed ? "justify-center" : "gap-3"} ${
                  isActive
                    ? "bg-accent-action/10 text-accent-foreground font-medium"
                    : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                }`}
                title={collapsed ? item.label : undefined}
              >
                <Icon size={18} strokeWidth={isActive ? 2.25 : 1.75} />
                {!collapsed && <span className="flex-1">{item.label}</span>}
                {!collapsed && showCount && (
                  <span className="text-xs tabular-nums text-on-surface-muted">{count}</span>
                )}
                {collapsed && (
                  <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-on-surface opacity-0 shadow-md transition-opacity group-hover:opacity-100">
                    {item.label}
                  </span>
                )}
              </button>
            );
          })}

          {/* My Projects section */}
          {!collapsed && (
            <div>
              <div className="flex items-center mt-5 mb-1 px-3">
                <button
                  type="button"
                  onClick={() => setProjectsExpanded(!projectsExpanded)}
                  aria-expanded={projectsExpanded}
                  aria-controls="sidebar-projects"
                  className={`flex min-h-6 items-center gap-1 text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider text-left hover:text-on-surface-secondary transition-colors flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                    phase3VisualFixture ? "pl-[22px]" : ""
                  }`}
                >
                  {projectsExpanded ? (
                    <ChevronDown size={12} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" />
                  )}
                  My Projects
                </button>
                <button
                  type="button"
                  onClick={onOpenProjectModal}
                  aria-label="New project"
                  title="New project"
                  className="flex h-6 w-6 items-center justify-center rounded text-on-surface-muted hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Plus size={14} />
                </button>
              </div>
              {projectsExpanded && (
                <ul id="sidebar-projects" className="space-y-0.5">
                  {rootProjects.length === 0 ? (
                    <li className="px-3 py-1 text-xs text-on-surface-muted">No projects yet</li>
                  ) : (
                    rootProjects.map((project) => renderProjectNode(project, 0))
                  )}
                </ul>
              )}
            </div>
          )}

          {/* Phase 3 first-party tools (after projects, matching legacy placement) */}
          {!phase2VisualFixture && (
            <div className={`${collapsed ? "" : "mt-5"} space-y-0.5`}>
              {TOOL_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = currentView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    aria-current={isActive ? "page" : undefined}
                    className={`group relative text-left px-3 py-1.5 rounded-md text-sm flex items-center transition-colors ${
                      phase3VisualFixture && !collapsed ? "ml-[26px] w-[calc(100%-26px)]" : "w-full"
                    } ${collapsed ? "justify-center" : "gap-3"} ${
                      isActive
                        ? "bg-accent-action/10 text-accent-foreground font-medium"
                        : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                    }`}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon size={18} strokeWidth={isActive ? 2.25 : 1.75} />
                    {!collapsed && <span className="flex-1">{item.label}</span>}
                    {collapsed && (
                      <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-on-surface opacity-0 shadow-md transition-opacity group-hover:opacity-100">
                        {item.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Saved Filters section */}
          {!collapsed && savedFilters.length > 0 && (
            <div>
              <div className="flex items-center mt-5 mb-1 px-3">
                <button
                  type="button"
                  onClick={() => setFiltersExpanded(!filtersExpanded)}
                  aria-expanded={filtersExpanded}
                  aria-controls="sidebar-filters"
                  className="flex min-h-6 items-center gap-1 text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider text-left hover:text-on-surface-secondary transition-colors flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {filtersExpanded ? (
                    <ChevronDown size={12} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" />
                  )}
                  My Filters
                </button>
              </div>
              {filtersExpanded && (
                <ul id="sidebar-filters" className="space-y-0.5">
                  {savedFilters.map((filter: SavedFilterDto) => {
                    const isActive =
                      currentRoute.name === "saved-filter" && currentRoute.filterId === filter.id;
                    return (
                      <li key={filter.id}>
                        <button
                          onClick={() => onNavigate({ name: "saved-filter", filterId: filter.id })}
                          aria-current={isActive ? "page" : undefined}
                          className={`w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center gap-2 transition-colors ${
                            isActive
                              ? "bg-accent-action/10 text-accent-foreground font-medium"
                              : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                          }`}
                        >
                          {filter.color && (
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: filter.color }}
                            />
                          )}
                          <span className="flex-1 truncate">{filter.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Workspace chrome — presentational until AI (Phase 6) and Settings (Phase 4). */}
        {!phase2VisualFixture && (
          <div
            className={`shrink-0 border-t border-border/60 ${collapsed ? "pt-2 pb-3" : "pt-3 pb-3"}`}
          >
            {!collapsed && (
              <h3 className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-on-surface-muted">
                Workspace
              </h3>
            )}
            <ul className="space-y-0.5">
              <li>
                <button
                  type="button"
                  title="AI Chat arrives in a later phase"
                  aria-disabled="true"
                  onClick={(event) => event.preventDefault()}
                  className={`group relative flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm text-on-surface-secondary transition-colors hover:bg-surface-tertiary hover:text-on-surface ${
                    collapsed ? "justify-center" : "gap-3"
                  }`}
                >
                  <MessageSquare size={18} strokeWidth={1.75} aria-hidden="true" />
                  {!collapsed && <span>AI Chat</span>}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  title="Settings arrives in Phase 4"
                  aria-disabled="true"
                  onClick={(event) => event.preventDefault()}
                  className={`group relative flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm text-on-surface-secondary transition-colors hover:bg-surface-tertiary hover:text-on-surface ${
                    collapsed ? "justify-center" : "gap-3"
                  }`}
                >
                  <Settings size={18} strokeWidth={1.75} aria-hidden="true" />
                  {!collapsed && <span>Settings</span>}
                </button>
              </li>
            </ul>
          </div>
        )}
      </nav>
    </aside>
  );
}
