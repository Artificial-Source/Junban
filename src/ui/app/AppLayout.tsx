import type { ReactNode } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { Sidebar } from "../components/Sidebar.js";
import { TaskDetailPanel } from "../components/TaskDetailPanel.js";
import { BulkActionBar } from "../components/BulkActionBar.js";
import { BottomNavBar } from "../components/BottomNavBar.js";
import { MobileDrawer } from "../components/MobileDrawer.js";
import { FAB } from "../components/FAB.js";
import { Breadcrumb, type BreadcrumbItem } from "../components/Breadcrumb.js";
import { SkeletonTaskList } from "../components/Skeleton.js";
import { AppStateProvider, type AppState } from "../context/AppStateContext.js";
import { ViewRenderer } from "./ViewRenderer.js";
import type {
  Task,
  Project as ProjectType,
  TaskComment,
  TaskActivity,
  UpdateTaskInput,
} from "../../core/types.js";
import type { View, CalendarMode } from "../hooks/useRouting.js";
import type { ViewInfo, PanelInfo } from "../api/index.js";
import type { ParsedTaskInput } from "./ViewRenderer.js";
import type { SettingsTab } from "../views/settings/types.js";

interface AppLayoutProps {
  // Routing
  currentView: View;
  selectedProjectId: string | null;
  selectedRouteTaskId: string | null;
  selectedPluginViewId: string | null;
  selectedFilterId: string | null;
  // Data
  tasks: Task[];
  projects: ProjectType[];
  availableTags: string[];
  loading: boolean;
  error: string | null;

  // Sidebar
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  panels: PanelInfo[];
  pluginViews: ViewInfo[];
  builtinPluginIds: Set<string>;
  savedFilters: Array<{ id: string; name: string; query: string; color?: string }>;
  projectTaskCounts: Map<string, number>;
  projectCompletedCounts: Map<string, number>;
  inboxTaskCount: number;
  todayTaskCount: number;

  // Mobile
  isMobile: boolean;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;

  // Multi-select & Bulk
  multiSelectedIds: Set<string>;
  handleBulkComplete: () => void;
  handleBulkDelete: () => void;
  handleBulkMoveToProject: (projectId: string | null) => void;
  handleBulkAddTag: (tag: string) => void;
  clearSelection: () => void;

  // Task detail
  selectedTask: Task | null;
  selectedTaskIdx: number;
  selectedTaskProjectName: string;
  visibleTasks: Task[];
  taskComments: TaskComment[];
  taskActivity: TaskActivity[];

  // Handlers
  handleNavigate: (view: View | string, id?: string) => void;
  handleOpenSettings: () => void;
  handleAddTask: () => void;
  handleOpenVoice: () => void;
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
  handleRestoreTask: (id: string) => void;
  handleActivateTask: (id: string) => void;
  handleCreateSection: (name: string) => void;
  handleUpdateSection: (id: string, data: { name?: string; isCollapsed?: boolean }) => void;
  handleDeleteSection: (id: string) => void;
  handleMoveTask: (taskId: string, sectionId: string | null) => void;
  handleCloseDetail: () => void;
  handleIndent: (taskId: string) => void;
  handleOutdent: (taskId: string) => void;
  handleAddComment: (taskId: string, content: string) => void;
  handleUpdateComment: (commentId: string, content: string) => void;
  handleDeleteComment: (commentId: string) => void;

  // Calendar
  setCalendarMode: (mode: CalendarMode) => void;
  addTaskTrigger: number;
  handleOpenSettingsTab: (tab: SettingsTab) => void;
  setSearchOpen: (open: boolean) => void;
  setProjectModalOpen: (open: boolean) => void;

  // AppState for context provider
  appState: AppState;

  // Optional children (modals)
  children?: ReactNode;
}

export function AppLayout({
  currentView,
  selectedProjectId,
  selectedRouteTaskId,
  selectedPluginViewId,
  selectedFilterId,
  tasks,
  projects,
  availableTags,
  loading,
  error,
  sidebarCollapsed,
  onToggleSidebar,
  panels,
  pluginViews,
  builtinPluginIds,
  savedFilters,
  projectTaskCounts,
  projectCompletedCounts,
  inboxTaskCount,
  todayTaskCount,
  isMobile,
  drawerOpen,
  setDrawerOpen,
  multiSelectedIds,
  handleBulkComplete,
  handleBulkDelete,
  handleBulkMoveToProject,
  handleBulkAddTag,
  clearSelection,
  selectedTask,
  selectedTaskIdx,
  selectedTaskProjectName,
  visibleTasks,
  taskComments,
  taskActivity,
  handleNavigate,
  handleOpenSettings,
  handleAddTask,
  handleOpenVoice,
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
  handleRestoreTask,
  handleActivateTask,
  handleCreateSection,
  handleUpdateSection,
  handleDeleteSection,
  handleMoveTask,
  handleCloseDetail,
  handleIndent,
  handleOutdent,
  handleAddComment,
  handleUpdateComment,
  handleDeleteComment,
  setCalendarMode,
  addTaskTrigger,
  handleOpenSettingsTab,
  setSearchOpen,
  setProjectModalOpen,
  appState,
  children,
}: AppLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-surface text-on-surface pb-[--height-bottom-nav] md:pb-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg focus:text-sm"
      >
        Skip to main content
      </a>
      <div className="flex flex-1 overflow-hidden">
        <div className="hidden md:flex">
          <Sidebar
            currentView={currentView}
            onNavigate={handleNavigate}
            onOpenSettings={handleOpenSettings}
            projects={projects}
            selectedProjectId={selectedProjectId}
            panels={panels}
            pluginViews={pluginViews}
            selectedPluginViewId={selectedPluginViewId}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={onToggleSidebar}
            projectTaskCounts={projectTaskCounts}
            projectCompletedCounts={projectCompletedCounts}
            onAddTask={handleAddTask}
            onSearch={() => setSearchOpen(true)}
            inboxCount={inboxTaskCount}
            todayCount={todayTaskCount}
            onOpenProjectModal={() => setProjectModalOpen(true)}
            builtinPluginIds={builtinPluginIds}
            savedFilters={savedFilters}
            selectedFilterId={selectedFilterId}
          />
        </div>
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto p-3 md:p-6 flex flex-col"
        >
          <div className="max-w-7xl w-full mx-auto flex-1 flex flex-col">
            <BulkActionBar
              selectedCount={multiSelectedIds.size}
              onCompleteAll={handleBulkComplete}
              onDeleteAll={handleBulkDelete}
              onMoveToProject={handleBulkMoveToProject}
              onAddTag={handleBulkAddTag}
              onClear={clearSelection}
              projects={projects}
            />
            {loading ? (
              <SkeletonTaskList />
            ) : error ? (
              <p role="alert" className="text-error">
                Error: {error}
              </p>
            ) : (
              <ErrorBoundary
                key={`${currentView}-${selectedProjectId ?? ""}-${selectedPluginViewId ?? ""}`}
              >
                <div className="animate-fade-in flex-1 flex flex-col">
                  {(currentView === "project" || currentView === "task") && (
                    <Breadcrumb
                      items={(() => {
                        const items: BreadcrumbItem[] = [];
                        if (currentView === "project") {
                          items.push({
                            label: "Projects",
                            onClick: () => handleNavigate("inbox"),
                          });
                          const project = projects.find((p) => p.id === selectedProjectId);
                          if (project) items.push({ label: project.name });
                        } else if (currentView === "task") {
                          const routeTask = selectedRouteTaskId
                            ? tasks.find((t) => t.id === selectedRouteTaskId)
                            : null;
                          if (routeTask?.projectId) {
                            const project = projects.find((p) => p.id === routeTask.projectId);
                            if (project)
                              items.push({
                                label: project.name,
                                onClick: () => handleNavigate("project", project.id),
                              });
                          }
                          if (routeTask) items.push({ label: routeTask.title });
                        }
                        return items;
                      })()}
                    />
                  )}
                  <AppStateProvider value={appState}>
                    <ViewRenderer
                      setCalendarMode={setCalendarMode}
                      addTaskTrigger={addTaskTrigger}
                      handleCreateTask={handleCreateTask}
                      handleToggleTask={handleToggleTask}
                      handleSelectTask={handleSelectTask}
                      handleUpdateTask={handleUpdateTask}
                      handleDeleteTask={handleDeleteTask}
                      handleMultiSelect={handleMultiSelect}
                      handleReorder={handleReorder}
                      handleAddSubtask={handleAddSubtask}
                      handleUpdateDueDate={handleUpdateDueDate}
                      handleContextMenu={handleContextMenu}
                      handleNavigate={handleNavigate}
                      handleRestoreTask={handleRestoreTask}
                      handleActivateTask={handleActivateTask}
                      handleCreateSection={handleCreateSection}
                      handleUpdateSection={handleUpdateSection}
                      handleDeleteSection={handleDeleteSection}
                      handleMoveTask={handleMoveTask}
                      handleOpenSettingsTab={handleOpenSettingsTab}
                    />
                  </AppStateProvider>
                </div>
              </ErrorBoundary>
            )}
          </div>
        </main>
      </div>

      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Sidebar
          currentView={currentView}
          onNavigate={handleNavigate}
          onOpenSettings={() => {
            setDrawerOpen(false);
            handleOpenSettings();
          }}
          projects={projects}
          selectedProjectId={selectedProjectId}
          panels={panels}
          pluginViews={pluginViews}
          selectedPluginViewId={selectedPluginViewId}
          collapsed={false}
          projectTaskCounts={projectTaskCounts}
          projectCompletedCounts={projectCompletedCounts}
          onAddTask={() => {
            setDrawerOpen(false);
            handleAddTask();
          }}
          onSearch={() => {
            setDrawerOpen(false);
            setSearchOpen(true);
          }}
          inboxCount={inboxTaskCount}
          todayCount={todayTaskCount}
          onOpenProjectModal={() => {
            setDrawerOpen(false);
            setProjectModalOpen(true);
          }}
          builtinPluginIds={builtinPluginIds}
          savedFilters={savedFilters}
          selectedFilterId={selectedFilterId}
        />
      </MobileDrawer>

      {isMobile && (
        <>
          <FAB onClick={handleAddTask} />
          <BottomNavBar
            currentView={currentView}
            onNavigate={handleNavigate}
            onMenuOpen={() => setDrawerOpen(true)}
            onOpenVoice={handleOpenVoice}
            inboxCount={inboxTaskCount}
            todayCount={todayTaskCount}
          />
        </>
      )}

      {selectedTask && currentView !== "task" && (
        <TaskDetailPanel
          task={selectedTask}
          allTasks={tasks}
          onUpdate={handleUpdateTask}
          onDelete={handleDeleteTask}
          onClose={handleCloseDetail}
          onIndent={handleIndent}
          onOutdent={handleOutdent}
          onSelect={handleSelectTask}
          onAddSubtask={handleAddSubtask}
          onToggleSubtask={handleToggleTask}
          onReorder={handleReorder}
          onNavigatePrev={
            selectedTaskIdx > 0
              ? () => handleSelectTask(visibleTasks[selectedTaskIdx - 1].id)
              : undefined
          }
          onNavigateNext={
            selectedTaskIdx >= 0 && selectedTaskIdx < visibleTasks.length - 1
              ? () => handleSelectTask(visibleTasks[selectedTaskIdx + 1].id)
              : undefined
          }
          onOpenFullPage={(id) => handleNavigate("task", id)}
          hasPrev={selectedTaskIdx > 0}
          hasNext={selectedTaskIdx >= 0 && selectedTaskIdx < visibleTasks.length - 1}
          projectName={selectedTaskProjectName}
          availableTags={availableTags}
          comments={taskComments}
          activity={taskActivity}
          onAddComment={handleAddComment}
          onUpdateComment={handleUpdateComment}
          onDeleteComment={handleDeleteComment}
        />
      )}

      {children}
    </div>
  );
}
