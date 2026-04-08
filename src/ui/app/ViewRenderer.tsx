import { lazy, Suspense } from "react";
import { motion } from "framer-motion";
import { AnimatedPresence } from "../components/AnimatedPresence.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { useReducedMotion } from "../components/useReducedMotion.js";
import { crossfade } from "../utils/animation-variants.js";
import { useAppState } from "../context/AppStateContext.js";
import type { UpdateTaskInput } from "../../core/types.js";
import type { CalendarMode } from "../hooks/useRouting.js";
import type { SettingsTab } from "../views/settings/types.js";

const Inbox = lazy(() => import("../views/Inbox.js").then((module) => ({ default: module.Inbox })));
const PluginView = lazy(() =>
  import("../views/PluginView.js").then((module) => ({ default: module.PluginView })),
);
const Today = lazy(() => import("../views/Today.js").then((module) => ({ default: module.Today })));
const Upcoming = lazy(() =>
  import("../views/Upcoming.js").then((module) => ({ default: module.Upcoming })),
);
const Project = lazy(() =>
  import("../views/Project.js").then((module) => ({ default: module.Project })),
);
const Completed = lazy(() =>
  import("../views/Completed.js").then((module) => ({ default: module.Completed })),
);
const Cancelled = lazy(() =>
  import("../views/Cancelled.js").then((module) => ({ default: module.Cancelled })),
);
const Someday = lazy(() =>
  import("../views/Someday.js").then((module) => ({ default: module.Someday })),
);
const Stats = lazy(() => import("../views/Stats.js").then((module) => ({ default: module.Stats })));
const Matrix = lazy(() =>
  import("../views/Matrix.js").then((module) => ({ default: module.Matrix })),
);
const Calendar = lazy(() =>
  import("../views/Calendar.js").then((module) => ({ default: module.Calendar })),
);
const FiltersLabels = lazy(() =>
  import("../views/FiltersLabels.js").then((module) => ({ default: module.FiltersLabels })),
);
const FilterView = lazy(() =>
  import("../views/FilterView.js").then((module) => ({ default: module.FilterView })),
);
const TaskPage = lazy(() =>
  import("../views/TaskPage.js").then((module) => ({ default: module.TaskPage })),
);
const AIChat = lazy(() =>
  import("../views/AIChat.js").then((module) => ({ default: module.AIChat })),
);
const DopamineMenu = lazy(() =>
  import("../views/DopamineMenu.js").then((module) => ({ default: module.DopamineMenu })),
);

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
  dreadLevel?: number | null;
}

interface ViewRendererProps {
  setCalendarMode: (mode: CalendarMode) => void;
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
  handleRestoreTask: (id: string) => void;
  handleActivateTask: (id: string) => void;
  handleCreateSection: (name: string) => void;
  handleUpdateSection: (id: string, data: { name?: string; isCollapsed?: boolean }) => void;
  handleDeleteSection: (id: string) => void;
  handleMoveTask: (taskId: string, sectionId: string | null) => void;
  handleOpenSettingsTab: (tab: SettingsTab) => void;
}

export function ViewRenderer({
  setCalendarMode,
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
  handleRestoreTask,
  handleActivateTask,
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
    featureSettings,
    pluginViews,
    calendarMode,
    sections,
    availableTags,
  } = useAppState();
  const reducedMotion = useReducedMotion();
  const viewKey = `${currentView}-${selectedProjectId ?? ""}-${selectedPluginViewId ?? ""}-${selectedFilterId ?? ""}`;
  const lazyFallback = (
    <div className="flex h-full items-center justify-center text-on-surface-secondary">
      Loading view...
    </div>
  );
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
      case "calendar":
        return wrapLazyView(
          <Calendar
            tasks={tasks}
            projects={projects}
            onSelectTask={handleSelectTask}
            onToggleTask={handleToggleTask}
            onUpdateDueDate={handleUpdateDueDate}
            mode={calendarMode}
            onModeChange={setCalendarMode}
          />,
        );
      case "filters-labels":
        return wrapLazyView(
          <FiltersLabels
            tasks={tasks}
            onNavigateToFilter={() => {
              handleNavigate("inbox");
            }}
          />,
        );
      case "completed":
        return wrapLazyView(
          <Completed tasks={tasks} projects={projects} onSelectTask={handleSelectTask} />,
        );
      case "cancelled":
        return featureSettings.feature_cancelled !== "false"
          ? wrapLazyView(
              <Cancelled
                tasks={tasks}
                projects={projects}
                onSelectTask={handleSelectTask}
                onRestoreTask={handleRestoreTask}
              />,
            )
          : null;
      case "someday":
        return featureSettings.feature_someday !== "false"
          ? wrapLazyView(
              <Someday
                tasks={tasks}
                onSelectTask={handleSelectTask}
                onActivateTask={handleActivateTask}
              />,
            )
          : null;
      case "stats":
        return featureSettings.feature_stats !== "false"
          ? wrapLazyView(<Stats tasks={tasks} />)
          : null;
      case "matrix":
        return featureSettings.feature_matrix !== "false"
          ? wrapLazyView(
              <Matrix
                tasks={tasks}
                onToggleTask={handleToggleTask}
                onSelectTask={handleSelectTask}
                onUpdateTask={handleUpdateTask}
                selectedTaskId={selectedTaskId}
              />,
            )
          : null;
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
      case "dopamine-menu":
        return featureSettings.feature_dopamine_menu !== "false"
          ? wrapLazyView(
              <DopamineMenu
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
      default:
        return null;
    }
  })();

  if (reducedMotion) {
    return <>{viewContent}</>;
  }

  return (
    <AnimatedPresence mode="wait">
      <motion.div
        key={viewKey}
        variants={crossfade}
        initial="initial"
        animate="animate"
        exit="exit"
        className="flex-1 flex flex-col"
      >
        {viewContent}
      </motion.div>
    </AnimatedPresence>
  );
}
