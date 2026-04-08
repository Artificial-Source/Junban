import { MessageSquare, Settings } from "lucide-react";
import type { ViewInfo } from "../../api/plugins.js";
import { CollapsedTooltip, renderNavButton } from "./SidebarPrimitives.js";

interface WorkspaceSectionProps {
  collapsed: boolean;
  currentView: string;
  selectedPluginViewId?: string | null;
  workspaceViews: ViewInfo[];
  onNavigate: (view: string, id?: string) => void;
  onOpenSettings?: () => void;
}

export function WorkspaceSection({
  collapsed,
  currentView,
  selectedPluginViewId,
  workspaceViews,
  onNavigate,
  onOpenSettings,
}: WorkspaceSectionProps) {
  return (
    <div className={`shrink-0 border-t border-border/60 ${collapsed ? "pt-2 pb-3" : "pt-3 pb-3"}`}>
      {!collapsed && (
        <h3 className="text-[11px] font-semibold text-on-surface-muted uppercase tracking-wider mb-1 px-3">
          Workspace
        </h3>
      )}
      <ul className="space-y-0.5">
        {workspaceViews.map((view) => {
          const isActive = currentView === "plugin-view" && selectedPluginViewId === view.id;
          return (
            <li key={`plugin-view-${view.id}`}>
              {renderNavButton(
                `plugin-view-${view.id}`,
                view.name,
                view.icon,
                isActive,
                () => onNavigate("plugin-view", view.id),
                collapsed,
              )}
            </li>
          );
        })}
        <li>
          {renderNavButton(
            "ai-chat",
            "AI Chat",
            MessageSquare,
            currentView === "ai-chat",
            () => onNavigate("ai-chat"),
            collapsed,
          )}
        </li>
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
  );
}
