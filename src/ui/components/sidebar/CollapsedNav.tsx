import { type MouseEvent as ReactMouseEvent } from "react";
import type { LucideIcon } from "lucide-react";
import type { Project } from "../../../core/types.js";
import type { ViewInfo } from "../../api/plugins.js";
import { CollapsedTooltip, SECTION_IDS, renderNavButton } from "./SidebarPrimitives.js";
import { ProjectButton } from "./ProjectTree.js";

interface CollapsedNavProps {
  orderedSidebarItems: string[];
  navItemMap: Map<
    string,
    { id: string; label: string; icon: LucideIcon | string; countKey?: "inbox" | "today" }
  >;
  countMap: Record<string, number | undefined>;
  currentView: string;
  selectedProjectId: string | null;
  selectedPluginViewId?: string | null;
  onNavigate: (view: string, id?: string) => void;
  onNavContextMenu: (e: ReactMouseEvent, itemId: string) => void;
  projects: Project[];
  viewsBySlot: { tools: ViewInfo[] };
  collapsed: boolean;
}

/** Renders the collapsed (icon-only) sidebar navigation. */
export function CollapsedNav({
  orderedSidebarItems,
  navItemMap,
  countMap,
  currentView,
  selectedProjectId,
  selectedPluginViewId,
  onNavigate,
  onNavContextMenu,
  projects,
  viewsBySlot,
  collapsed,
}: CollapsedNavProps) {
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
