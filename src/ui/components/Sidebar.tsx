import type { Project } from "../../core/types.js";
import type { PanelInfo, ViewInfo } from "../api.js";

interface SidebarProps {
  currentView: string;
  onNavigate: (view: string, id?: string) => void;
  projects: Project[];
  selectedProjectId: string | null;
  panels?: PanelInfo[];
  pluginViews?: ViewInfo[];
  selectedPluginViewId?: string | null;
}

const NAV_ITEMS = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "today", label: "Today", icon: "calendar" },
  { id: "upcoming", label: "Upcoming", icon: "clock" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "plugin-store", label: "Plugin Store", icon: "store" },
];

export function Sidebar({
  currentView,
  onNavigate,
  projects,
  selectedProjectId,
  panels = [],
  pluginViews = [],
  selectedPluginViewId,
}: SidebarProps) {
  return (
    <aside className="w-56 border-r border-gray-200 dark:border-gray-700 p-4 flex flex-col overflow-auto">
      <h2 className="text-lg font-bold mb-4">Docket</h2>
      <nav className="flex-1">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => onNavigate(item.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm ${
                  currentView === item.id
                    ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>

        {projects.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-6 mb-2 px-3">
              Projects
            </h3>
            <ul className="space-y-1">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    onClick={() => onNavigate("project", project.id)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 ${
                      currentView === "project" && selectedProjectId === project.id
                        ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium"
                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                    {project.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {panels.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-6 mb-2 px-3">
              Plugins
            </h3>
            <div className="space-y-2 px-3">
              {panels.map((panel) => (
                <div
                  key={panel.id}
                  className="p-2 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
                >
                  <div className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    <span>{panel.icon}</span>
                    <span>{panel.title}</span>
                  </div>
                  {panel.content && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap">
                      {panel.content}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {pluginViews.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-6 mb-2 px-3">
              Plugin Views
            </h3>
            <ul className="space-y-1">
              {pluginViews.map((view) => (
                <li key={view.id}>
                  <button
                    onClick={() => onNavigate("plugin-view", view.id)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 ${
                      currentView === "plugin-view" && selectedPluginViewId === view.id
                        ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium"
                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                    }`}
                  >
                    <span>{view.icon}</span>
                    {view.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
    </aside>
  );
}
