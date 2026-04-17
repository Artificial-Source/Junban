import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { ViewSkeleton } from "../components/Skeleton.js";
import { useReducedMotion } from "../components/useReducedMotion.js";
import { useAppState } from "../context/AppStateContext.js";
import type { UpdateTaskInput } from "../../core/types.js";
import type { SettingsTab } from "../views/settings/types.js";
import { Inbox } from "../views/Inbox.js";
import { Today } from "../views/Today.js";
import { Upcoming } from "../views/Upcoming.js";

const loadPluginView = () => import("../views/PluginView.js");
const loadProject = () => import("../views/Project.js");
const loadFiltersLabels = () => import("../views/FiltersLabels.js");
const loadFilterView = () => import("../views/FilterView.js");
const loadTaskPage = () => import("../views/TaskPage.js");
const loadAIChat = () => import("../views/AIChat.js");

const PluginView = lazy(() => loadPluginView().then((module) => ({ default: module.PluginView })));
const Project = lazy(() => loadProject().then((module) => ({ default: module.Project })));
const FiltersLabels = lazy(() =>
  loadFiltersLabels().then((module) => ({ default: module.FiltersLabels })),
);
const FilterView = lazy(() => loadFilterView().then((module) => ({ default: module.FilterView })));
const TaskPage = lazy(() => loadTaskPage().then((module) => ({ default: module.TaskPage })));
const AIChat = lazy(() => loadAIChat().then((module) => ({ default: module.AIChat })));

const VIEW_PRELOADERS = {
  "plugin-view": loadPluginView,
  project: loadProject,
  "filters-labels": loadFiltersLabels,
  filter: loadFilterView,
  task: loadTaskPage,
  "ai-chat": loadAIChat,
} as const;

/** Parsed task input from TaskInput / QuickAdd — mirrors useTaskHandlers.handleCreateTask param. */
export interface ParsedTaskInput {
  title: string;
  priority: number | null;
  tags: string[];
  project: string | null;
  dueDate: Date | null;
  dueTime: boolean;
  recurrence?: string | null;
  estimatedMinutes?: number | null;
  deadline?: Date | null;
  isSomeday?: boolean;
  sectionId?: string | null;
  dreadLevel?: number | null;
}

interface ViewRendererProps {
  addTaskTrigger: number;
  handleCreateTask: (data: ParsedTaskInput) => void;
  handleToggleTask: (id: string) => void;
  handleSelectTask: (id: string) => void;
  handleUpdateTask: (id: string, data: UpdateTaskInput) => void;
  handleDeleteTask: (id: string) => void;
  handleMultiSelect: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  handleReorder: (orderedIds: string[]) => void;
  handleAddSubtask: (parentId: string, title: string) => void;
  handleUpdateDueDate: (id: string, date: string | null) => void;
  handleContextMenu: (taskId: string, position: { x: number; y: number }) => void;
  handleNavigate: (view: string, id?: string) => void;
  handleCreateSection: (name: string) => void;
  handleUpdateSection: (id: string, data: { name?: string; isCollapsed?: boolean }) => void;
  handleDeleteSection: (id: string) => void;
  handleMoveTask: (taskId: string, sectionId: string | null) => void;
  handleOpenSettingsTab: (tab: SettingsTab) => void;
}

export function ViewRenderer({
  addTaskTrigger,
  handleCreateTask,
  handleToggleTask,
  handleSelectTask,
  handleUpdateTask,
  handleDeleteTask,
  handleMultiSelect,
  handleReorder,
  handleAddSubtask,
  handleUpdateDueDate,
  handleContextMenu,
  handleNavigate,
  handleCreateSection,
  handleUpdateSection,
  handleDeleteSection,
  handleMoveTask,
  handleOpenSettingsTab,
}: ViewRendererProps) {
  const {
    currentView,
    tasks,
    projects,
    selectedProjectId,
    selectedRouteTaskId,
    selectedPluginViewId,
    selectedFilterId,
    selectedTaskId,
    multiSelectedIds,
    pluginViews,
    sections,
    availableTags,
  } = useAppState();
  const reducedMotion = useReducedMotion();
  const viewKey = `${currentView}-${selectedProjectId ?? ""}-${selectedPluginViewId ?? ""}-${selectedFilterId ?? ""}`;
  const lazyFallback = <ViewSkeleton view={currentView} />;
  const lazyErrorFallback = (
    <div className="flex h-full items-center justify-center text-error">
      Failed to load this view. Refresh and try again.
    </div>
  );
  const wrapLazyView = (content: React.ReactNode) => (
    <ErrorBoundary fallback={lazyErrorFallback}>
      <Suspense fallback={lazyFallback}>{content}</Suspense>
    </ErrorBoundary>
  );

  useEffect(() => {
    const preloadCurrentView = VIEW_PRELOADERS[currentView as keyof typeof VIEW_PRELOADERS];
    preloadCurrentView?.();

    const preloadCommonViews = () => {
      loadFiltersLabels();
      loadTaskPage();
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleHandle = window.requestIdleCallback(preloadCommonViews, { timeout: 1200 });
      return () => window.cancelIdleCallback(idleHandle);
    }

    const timeoutHandle = globalThis.setTimeout(preloadCommonViews, 250);
    return () => globalThis.clearTimeout(timeoutHandle);
  }, [currentView]);

  const viewContent = (() => {
    switch (currentView) {
      case "inbox":
        return wrapLazyView(
          <Inbox
            tasks={tasks}
            onCreateTask={handleCreateTask}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            selectedTaskId={selectedTaskId}
            selectedTaskIds={multiSelectedIds}
            onMultiSelect={handleMultiSelect}
            onReorder={handleReorder}
            onAddSubtask={handleAddSubtask}
            onUpdateDueDate={handleUpdateDueDate}
            onContextMenu={handleContextMenu}
            autoFocusTrigger={addTaskTrigger}
          />,
        );
      case "today":
        return wrapLazyView(
          <Today
            tasks={tasks}
            projects={projects}
            onCreateTask={handleCreateTask}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            onUpdateTask={handleUpdateTask}
            selectedTaskId={selectedTaskId}
            selectedTaskIds={multiSelectedIds}
            onMultiSelect={handleMultiSelect}
            onReorder={handleReorder}
            onAddSubtask={handleAddSubtask}
            onUpdateDueDate={handleUpdateDueDate}
            onContextMenu={handleContextMenu}
            autoFocusTrigger={addTaskTrigger}
          />,
        );
      case "upcoming":
        return wrapLazyView(
          <Upcoming
            tasks={tasks}
            projects={projects}
            onCreateTask={handleCreateTask}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            onUpdateTask={handleUpdateTask}
            selectedTaskId={selectedTaskId}
            selectedTaskIds={multiSelectedIds}
            onMultiSelect={handleMultiSelect}
            onReorder={handleReorder}
            onAddSubtask={handleAddSubtask}
            onUpdateDueDate={handleUpdateDueDate}
            onContextMenu={handleContextMenu}
            autoFocusTrigger={addTaskTrigger}
          />,
        );
      case "project": {
        const project = projects.find((p) => p.id === selectedProjectId);
        if (!project) {
          return <p className="text-on-surface-muted">Project not found.</p>;
        }
        return wrapLazyView(
          <Project
            project={project}
            tasks={tasks}
            onCreateTask={handleCreateTask}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            selectedTaskId={selectedTaskId}
            selectedTaskIds={multiSelectedIds}
            onMultiSelect={handleMultiSelect}
            onReorder={handleReorder}
            onAddSubtask={handleAddSubtask}
            onUpdateDueDate={handleUpdateDueDate}
            onContextMenu={handleContextMenu}
            autoFocusTrigger={addTaskTrigger}
            viewStyle={project.viewStyle}
            sections={sections}
            onCreateSection={handleCreateSection}
            onUpdateSection={handleUpdateSection}
            onDeleteSection={handleDeleteSection}
            onMoveTask={handleMoveTask}
          />,
        );
      }
      case "task": {
        const routeTask = selectedRouteTaskId
          ? tasks.find((t) => t.id === selectedRouteTaskId)
          : null;
        if (!routeTask) {
          return <p className="text-on-surface-muted">Task not found.</p>;
        }
        return wrapLazyView(
          <TaskPage
            task={routeTask}
            allTasks={tasks}
            projects={projects}
            onUpdate={handleUpdateTask}
            onDelete={(id: string) => {
              handleDeleteTask(id);
              handleNavigate("inbox");
            }}
            onNavigateBack={() => window.history.back()}
            onSelect={(id: string) => handleNavigate("task", id)}
            onAddSubtask={handleAddSubtask}
            onToggleSubtask={handleToggleTask}
            onReorder={handleReorder}
            availableTags={availableTags}
          />,
        );
      }
      case "filters-labels":
        return wrapLazyView(
          <FiltersLabels
            tasks={tasks}
            onNavigateToFilter={() => {
              handleNavigate("inbox");
            }}
          />,
        );
      case "filter":
        return selectedFilterId
          ? wrapLazyView(
              <FilterView
                filterId={selectedFilterId}
                tasks={tasks}
                onToggleTask={handleToggleTask}
                onSelectTask={handleSelectTask}
                selectedTaskId={selectedTaskId}
                selectedTaskIds={multiSelectedIds}
                onMultiSelect={handleMultiSelect}
                onReorder={handleReorder}
                onAddSubtask={handleAddSubtask}
                onUpdateDueDate={handleUpdateDueDate}
                onContextMenu={handleContextMenu}
              />,
            )
          : null;
      case "plugin-view": {
        const viewInfo = pluginViews.find((v) => v.id === selectedPluginViewId);
        return selectedPluginViewId ? (
          wrapLazyView(<PluginView viewId={selectedPluginViewId} viewInfo={viewInfo} />)
        ) : (
          <p className="text-on-surface-muted">No plugin view selected.</p>
        );
      }
      case "ai-chat":
        return wrapLazyView(
          <AIChat
            onOpenSettings={() => handleOpenSettingsTab("ai")}
            onSelectTask={handleSelectTask}
          />,
        );
      default:
        return null;
    }
  })();

  return (
    <div key={viewKey} className={`flex-1 flex flex-col ${reducedMotion ? "" : "animate-fade-in"}`}>
      {viewContent}
    </div>
  );
}
