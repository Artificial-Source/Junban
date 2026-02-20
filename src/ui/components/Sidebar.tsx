import { useState } from "react";
import {
  Inbox,
  CalendarDays,
  Clock,
  Settings,
  Puzzle,
  MessageSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Focus,
  Plus,
  Search,
  SlidersHorizontal,
  CheckCircle2,
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
  onToggleChat?: () => void;
  chatOpen?: boolean;
  onFocusMode?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  projectTaskCounts?: Map<string, number>;
  onAddTask?: () => void;
  onSearch?: () => void;
  inboxCount?: number;
  todayCount?: number;
  onCreateProject?: (name: string, color: string, icon: string) => void;
}

const TASK_NAV_ITEMS: Array<{
  id: string;
  label: string;
  icon: typeof Inbox;
  countKey?: "inbox" | "today";
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox, countKey: "inbox" },
  { id: "today", label: "Today", icon: CalendarDays, countKey: "today" },
  { id: "upcoming", label: "Upcoming", icon: Clock },
  { id: "filters-labels", label: "Filters & Labels", icon: SlidersHorizontal },
  { id: "completed", label: "Completed", icon: CheckCircle2 },
];

const WORKSPACE_NAV_ITEMS = [{ id: "plugin-store", label: "Plugin Store", icon: Puzzle }];

export function Sidebar({
  currentView,
  onNavigate,
  onOpenSettings,
  projects,
  selectedProjectId,
  panels = [],
  pluginViews = [],
  selectedPluginViewId,
  onToggleChat,
  chatOpen,
  onFocusMode,
  collapsed = false,
  onToggleCollapsed,
  projectTaskCounts,
  onAddTask,
  onSearch,
  inboxCount,
  todayCount,
  onCreateProject,
}: SidebarProps) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectColor, setNewProjectColor] = useState("#3b82f6");
  const [newProjectIcon, setNewProjectIcon] = useState("");
  const showToolsSection = Boolean(onFocusMode || onToggleChat);

  const countMap: Record<string, number | undefined> = {
    inbox: inboxCount,
    today: todayCount,
  };

  const renderNavItems = (items: typeof TASK_NAV_ITEMS) => {
    return items.map((item) => {
      const Icon = item.icon;
      const isActive = currentView === item.id;
      const count = item.countKey ? countMap[item.countKey] : undefined;
      return (
        <li key={item.id}>
          <button
            onClick={() => onNavigate(item.id)}
            aria-current={isActive ? "page" : undefined}
            className={`group relative w-full text-left px-3 py-2 rounded-md text-sm flex items-center transition-colors ${
              collapsed ? "justify-center" : "gap-3"
            } ${
              isActive
                ? "bg-accent/10 text-accent font-medium"
                : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
            }`}
          >
            <Icon size={18} strokeWidth={isActive ? 2.25 : 1.75} />
            {!collapsed && item.label}
            {!collapsed && count !== undefined && count > 0 && (
              <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-surface-tertiary text-on-surface-secondary font-medium">
                {count}
              </span>
            )}
            <CollapsedTooltip visible={collapsed} label={item.label} />
          </button>
        </li>
      );
    });
  };

  const renderToolButtons = () => {
    return (
      <>
        {onToggleChat && (
          <button
            onClick={onToggleChat}
            aria-label={chatOpen ? "Close AI chat panel" : "Open AI chat panel"}
            aria-pressed={chatOpen}
            className={`group relative w-full px-3 py-2 rounded-md text-sm flex items-center transition-colors ${
              collapsed ? "justify-center" : "gap-3"
            } ${
              chatOpen
                ? "bg-accent/10 text-accent font-medium"
                : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
            }`}
          >
            <MessageSquare size={18} strokeWidth={chatOpen ? 2.25 : 1.75} />
            {!collapsed && "AI Chat"}
            <CollapsedTooltip visible={collapsed} label="AI Chat" />
          </button>
        )}
        {onFocusMode && (
          <button
            onClick={onFocusMode}
            aria-label="Enter focus mode"
            className={`group relative w-full px-3 py-2 rounded-md text-sm flex items-center transition-colors text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface ${
              collapsed ? "justify-center" : "gap-3"
            }`}
          >
            <Focus size={18} strokeWidth={1.75} />
            {!collapsed && "Focus Mode"}
            <CollapsedTooltip visible={collapsed} label="Focus Mode" />
          </button>
        )}
      </>
    );
  };

  return (
    <aside
      aria-label="Main navigation"
      className={`relative z-20 border-r border-border bg-surface-secondary flex flex-col transition-all ${
        collapsed ? "w-16 overflow-visible" : "w-sidebar overflow-y-auto"
      }`}
    >
      <div className={`py-4 ${collapsed ? "px-2" : "px-5"}`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <img src="/images/logo.svg" alt="Saydo logo" className="w-7 h-7" />
              <h2 className="text-lg font-bold text-on-surface tracking-tight">Saydo</h2>
            </div>
          ) : (
            <img src="/images/logo.svg" alt="Saydo logo" className="w-7 h-7" />
          )}
          {onToggleCollapsed && (
            <button
              onClick={onToggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="group relative p-2 rounded-md text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface transition-colors"
            >
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              <CollapsedTooltip visible={collapsed} label="Expand sidebar" />
            </button>
          )}
        </div>

        {/* Add task button */}
        {onAddTask && (
          <button
            onClick={onAddTask}
            className={`mt-3 w-full flex items-center rounded-lg bg-accent text-white font-medium text-sm transition-colors hover:bg-accent/90 ${
              collapsed ? "justify-center p-2" : "gap-2 px-3 py-2"
            }`}
          >
            <Plus size={18} />
            {!collapsed && "Add task"}
          </button>
        )}

        {/* Search button */}
        {onSearch && !collapsed && (
          <button
            onClick={onSearch}
            className="mt-2 w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
          >
            <Search size={16} />
            Search
          </button>
        )}
        {onSearch && collapsed && (
          <button
            onClick={onSearch}
            aria-label="Search"
            className="group relative mt-2 w-full flex items-center justify-center p-2 rounded-lg text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors"
          >
            <Search size={16} />
            <CollapsedTooltip visible={collapsed} label="Search" />
          </button>
        )}
      </div>
      <nav aria-label="Views" className={`flex-1 flex flex-col ${collapsed ? "px-2" : "px-3"}`}>
        <div>
          {!collapsed && (
            <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2 px-3">
              Tasks
            </h3>
          )}
          <ul className="space-y-0.5">{renderNavItems(TASK_NAV_ITEMS)}</ul>

          {!collapsed && (projects.length > 0 || onCreateProject) && (
            <>
              <div className="flex items-center mt-6 mb-2 px-3">
                <button
                  onClick={() => setProjectsExpanded(!projectsExpanded)}
                  className="flex items-center gap-1 text-xs font-semibold text-on-surface-muted uppercase tracking-wider text-left hover:text-on-surface-secondary transition-colors flex-1"
                >
                  {projectsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  My Projects
                </button>
                {onCreateProject && projectsExpanded && (
                  <button
                    onClick={() => setShowProjectForm((v) => !v)}
                    title="New project"
                    className="p-0.5 rounded text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
                  >
                    <Plus size={14} />
                  </button>
                )}
              </div>
              {projectsExpanded && showProjectForm && onCreateProject && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = newProjectName.trim();
                    if (!name) return;
                    onCreateProject(name, newProjectColor, newProjectIcon);
                    setNewProjectName("");
                    setNewProjectColor("#3b82f6");
                    setNewProjectIcon("");
                    setShowProjectForm(false);
                  }}
                  className="mx-3 mb-2 p-2 rounded-lg border border-border bg-surface-tertiary space-y-2"
                >
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="Project name"
                    autoFocus
                    className="w-full px-2 py-1.5 text-xs border border-border rounded bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newProjectIcon}
                      onChange={(e) => setNewProjectIcon(e.target.value)}
                      placeholder="Emoji"
                      maxLength={2}
                      className="w-12 px-2 py-1.5 text-xs text-center border border-border rounded bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <input
                      type="color"
                      value={newProjectColor}
                      onChange={(e) => setNewProjectColor(e.target.value)}
                      title="Project color"
                      className="w-7 h-7 rounded border border-border cursor-pointer"
                    />
                    <button
                      type="submit"
                      disabled={!newProjectName.trim()}
                      className="ml-auto px-2.5 py-1 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
                    >
                      Add
                    </button>
                  </div>
                </form>
              )}
              {projectsExpanded && (
                <ul className="space-y-0.5">
                  {projects.map((project) => {
                    const isActive = currentView === "project" && selectedProjectId === project.id;
                    const projectCount = projectTaskCounts?.get(project.id) ?? 0;
                    return (
                      <li key={project.id}>
                        <button
                          onClick={() => onNavigate("project", project.id)}
                          aria-current={isActive ? "page" : undefined}
                          className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-3 transition-colors ${
                            isActive
                              ? "bg-accent/10 text-accent font-medium"
                              : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                          }`}
                        >
                          {project.icon ? (
                            <span
                              aria-hidden="true"
                              className="flex-shrink-0 text-base leading-none"
                            >
                              {project.icon}
                            </span>
                          ) : (
                            <span
                              aria-hidden="true"
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: project.color }}
                            />
                          )}
                          <span className="flex-1">{project.name}</span>
                          {projectCount > 0 && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface-tertiary text-on-surface-secondary font-medium">
                              {projectCount}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {!collapsed && panels.length > 0 && (
            <>
              <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mt-6 mb-2 px-3">
                Plugin Panels
              </h3>
              <div className="space-y-2 px-3">
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

          {!collapsed && pluginViews.length > 0 && (
            <>
              <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mt-6 mb-2 px-3">
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
                        className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-3 transition-colors ${
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

          {collapsed && showToolsSection && (
            <div className="mx-2 my-3 border-t border-border/80" aria-hidden="true" />
          )}

          {showToolsSection && (
            <>
              {!collapsed && (
                <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mt-6 mb-2 px-3">
                  Tools
                </h3>
              )}
              <div className="space-y-0.5">{renderToolButtons()}</div>
            </>
          )}
        </div>

        <div className={`mt-auto ${collapsed ? "pb-3" : "pt-4 pb-3"}`}>
          {collapsed && <div className="mx-2 mb-3 border-t border-border/80" aria-hidden="true" />}
          {!collapsed && (
            <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2 px-3">
              Workspace
            </h3>
          )}
          <ul className="space-y-0.5">
            {renderNavItems(WORKSPACE_NAV_ITEMS)}
            {onOpenSettings && (
              <li>
                <button
                  onClick={onOpenSettings}
                  className={`group relative w-full text-left px-3 py-2 rounded-md text-sm flex items-center transition-colors text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface ${
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
