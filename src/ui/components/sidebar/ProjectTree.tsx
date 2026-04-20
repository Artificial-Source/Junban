import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Project } from "../../../core/types.js";
import { CollapsedTooltip } from "./SidebarPrimitives.js";

interface ProjectTreeProps {
  projects: Project[];
  currentView: string;
  selectedProjectId: string | null;
  onNavigate: (view: string, id?: string) => void;
  projectTaskCounts?: Map<string, number>;
  projectCompletedCounts?: Map<string, number>;
  collapsed: boolean;
  onContextMenu?: (e: ReactMouseEvent, project: Project) => void;
}

export function ProjectTree({
  projects,
  currentView,
  selectedProjectId,
  onNavigate,
  projectTaskCounts,
  projectCompletedCounts,
  collapsed,
  onContextMenu,
}: ProjectTreeProps) {
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

  const nonArchived = projects.filter((p) => !p.archived);
  const roots = nonArchived.filter((p) => p.parentId === null);
  const childrenMap = new Map<string, Project[]>();
  for (const p of nonArchived) {
    if (p.parentId) {
      const existing = childrenMap.get(p.parentId) ?? [];
      existing.push(p);
      childrenMap.set(p.parentId, existing);
    }
  }

  const toggleParentExpanded = (id: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul className="space-y-0.5">
      {roots.map((project) => {
        const children = childrenMap.get(project.id) ?? [];
        const hasChildren = children.length > 0;
        const isParentExpanded = expandedParents.has(project.id);
        return (
          <li key={project.id}>
            <div className="flex items-center">
              {hasChildren && (
                <button
                  onClick={() => toggleParentExpanded(project.id)}
                  aria-label={`${isParentExpanded ? "Collapse" : "Expand"} ${project.name} subprojects`}
                  aria-expanded={isParentExpanded}
                  className="p-0.5 mr-0.5 rounded text-on-surface-muted hover:text-on-surface-secondary transition-colors"
                >
                  {isParentExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              )}
              <div className={`flex-1 ${!hasChildren ? "ml-5" : ""}`}>
                <ProjectButton
                  project={project}
                  isActive={currentView === "project" && selectedProjectId === project.id}
                  onNavigate={onNavigate}
                  projectTaskCounts={projectTaskCounts}
                  projectCompletedCounts={projectCompletedCounts}
                  collapsed={collapsed}
                  onContextMenu={onContextMenu}
                />
              </div>
            </div>
            {hasChildren && isParentExpanded && (
              <ul className="ml-4 space-y-0.5">
                {children.map((child) => (
                  <li key={child.id}>
                    <ProjectButton
                      project={child}
                      isActive={currentView === "project" && selectedProjectId === child.id}
                      onNavigate={onNavigate}
                      projectTaskCounts={projectTaskCounts}
                      projectCompletedCounts={projectCompletedCounts}
                      collapsed={collapsed}
                      onContextMenu={onContextMenu}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectButton({
  project,
  isActive,
  onNavigate,
  projectTaskCounts,
  projectCompletedCounts,
  collapsed = false,
  onContextMenu,
}: {
  project: Project;
  isActive: boolean;
  onNavigate: (view: string, id?: string) => void;
  projectTaskCounts?: Map<string, number>;
  projectCompletedCounts?: Map<string, number>;
  collapsed?: boolean;
  onContextMenu?: (e: ReactMouseEvent, project: Project) => void;
}) {
  const pendingCount = projectTaskCounts?.get(project.id) ?? 0;
  const completedCount = projectCompletedCounts?.get(project.id) ?? 0;
  const totalCount = pendingCount + completedCount;
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  if (collapsed) {
    return (
      <button
        onClick={() => onNavigate("project", project.id)}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, project) : undefined}
        title={project.name}
        aria-current={isActive ? "page" : undefined}
        className={`group relative w-full flex items-center justify-center p-1.5 rounded-lg transition-colors ${
          isActive
            ? "bg-accent/10 text-accent"
            : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
        }`}
      >
        {project.icon ? (
          <span className="text-base leading-none">{project.icon}</span>
        ) : (
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: project.color }} />
        )}
        <CollapsedTooltip visible={collapsed} label={project.name} />
      </button>
    );
  }

  return (
    <button
      onClick={() => onNavigate("project", project.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, project) : undefined}
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
          <div
            className="w-12 h-1 rounded-full bg-surface-tertiary overflow-hidden"
            title={`${progressPct}% complete`}
          >
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
}
