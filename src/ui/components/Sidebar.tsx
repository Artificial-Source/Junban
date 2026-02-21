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
} from "lucide-react";
import type { Project } from "../../core/types.js";
import type { PanelInfo, ViewInfo } from "../api/index.js";

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
  onAddTask?: () => void;
  onSearch?: () => void;
  inboxCount?: number;
  todayCount?: number;
  onOpenProjectModal?: () => void;
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
  onAddTask,
  onSearch,
  inboxCount,
  todayCount,
  onOpenProjectModal,
}: SidebarProps) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

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
    Icon: typeof Inbox,
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
        <Icon size={18} strokeWidth={isActive ? 2.25 : 1.75} />
        {!collapsed && <span className="flex-1">{label}</span>}
        {!collapsed && count !== undefined && count > 0 && (
          <span className="text-xs tabular-nums text-on-surface-muted">{count}</span>
        )}
        <CollapsedTooltip visible={collapsed} label={label} />
      </button>
    </li>
  );

  const renderProjectButton = (project: Project) => {
    const isActive = currentView === "project" && selectedProjectId === project.id;
    const projectCount = projectTaskCounts?.get(project.id) ?? 0;
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
        {projectCount > 0 && (
          <span className="text-xs tabular-nums text-on-surface-muted">{projectCount}</span>
        )}
      </button>
    );
  };

  return (
    <aside
      aria-label="Main navigation"
      className={`relative z-20 border-r border-border bg-surface-secondary flex flex-col transition-all ${
        collapsed ? "w-16 overflow-visible" : "w-sidebar overflow-y-auto"
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
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {/* Nav items — no section header needed (it's the primary content) */}
          <ul className="space-y-0.5">
            {NAV_ITEMS.map((item) =>
              renderNavButton(
                item.id,
                item.label,
                item.icon,
                currentView === item.id,
                () => onNavigate(item.id),
                item.countKey ? countMap[item.countKey] : undefined,
              ),
            )}
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

          {/* ── Plugin Panels ── */}
          {!collapsed && panels.length > 0 && (
            <>
              <h3 className="text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider mt-5 mb-1 px-3">
                Plugin Panels
              </h3>
              <div className="space-y-1.5 px-3">
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
            </>
          )}

          {/* ── Custom Views ── */}
          {!collapsed && pluginViews.length > 0 && (
            <>
              <h3 className="text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider mt-5 mb-1 px-3">
                Custom Views
              </h3>
              <ul className="space-y-0.5">
                {pluginViews.map((view) => {
                  const isActive =
                    currentView === "plugin-view" && selectedPluginViewId === view.id;
                  return (
                    <li key={view.id}>
                      <button
                        onClick={() => onNavigate("plugin-view", view.id)}
                        aria-current={isActive ? "page" : undefined}
                        className={`w-full text-left px-3 py-1.5 rounded-md text-sm flex items-center gap-3 transition-colors ${
                          isActive
                            ? "bg-accent/10 text-accent font-medium"
                            : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                        }`}
                      >
                        <span>{view.icon}</span>
                        {view.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
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
