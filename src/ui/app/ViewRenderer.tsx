import { motion } from "framer-motion";
import { AnimatedPresence } from "../components/AnimatedPresence.js";
import { useReducedMotion } from "../components/useReducedMotion.js";
import { crossfade } from "../utils/animation-variants.js";
import { Inbox } from "../views/Inbox.js";
import { Today } from "../views/Today.js";
import { Upcoming } from "../views/Upcoming.js";
import { Project } from "../views/Project.js";
import { PluginView } from "../views/PluginView.js";
import { Completed } from "../views/Completed.js";
import { Cancelled } from "../views/Cancelled.js";
import { Someday } from "../views/Someday.js";
import { Stats } from "../views/Stats.js";
import { Matrix } from "../views/Matrix.js";
import { Calendar } from "../views/Calendar.js";
import { FiltersLabels } from "../views/FiltersLabels.js";
import { FilterView } from "../views/FilterView.js";
import { TaskPage } from "../views/TaskPage.js";
import { AIChat } from "../views/AIChat.js";
import { DopamineMenu } from "../views/DopamineMenu.js";
import { useAppState } from "../context/AppStateContext.js";
import type { UpdateTaskInput } from "../../core/types.js";
import type { CalendarMode } from "../hooks/useRouting.js";
import type { SettingsTab } from "../views/settings/types.js";

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

  const viewContent = (() => {
    switch (currentView) {
      case "inbox":
        return (
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
          />
        );
      case "today":
        return (
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
          />
        );
      case "upcoming":
        return (
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
          />
        );
      case "project": {
        const project = projects.find((p) => p.id === selectedProjectId);
        if (!project) {
          return <p className="text-on-surface-muted">Project not found.</p>;
        }
        return (
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
          />
        );
      }
      case "task": {
        const routeTask = selectedRouteTaskId
          ? tasks.find((t) => t.id === selectedRouteTaskId)
          : null;
        if (!routeTask) {
          return <p className="text-on-surface-muted">Task not found.</p>;
        }
        return (
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
          />
        );
      }
      case "calendar":
        return (
          <Calendar
            tasks={tasks}
            projects={projects}
            onSelectTask={handleSelectTask}
            onToggleTask={handleToggleTask}
            onUpdateDueDate={handleUpdateDueDate}
            mode={calendarMode}
            onModeChange={setCalendarMode}
          />
        );
      case "filters-labels":
        return (
          <FiltersLabels
            tasks={tasks}
            onNavigateToFilter={() => {
              handleNavigate("inbox");
            }}
          />
        );
      case "completed":
        return <Completed tasks={tasks} projects={projects} onSelectTask={handleSelectTask} />;
      case "cancelled":
        return featureSettings.feature_cancelled !== "false" ? (
          <Cancelled
            tasks={tasks}
            projects={projects}
            onSelectTask={handleSelectTask}
            onRestoreTask={handleRestoreTask}
          />
        ) : null;
      case "someday":
        return featureSettings.feature_someday !== "false" ? (
          <Someday
            tasks={tasks}
            onSelectTask={handleSelectTask}
            onActivateTask={handleActivateTask}
          />
        ) : null;
      case "stats":
        return featureSettings.feature_stats !== "false" ? <Stats tasks={tasks} /> : null;
      case "matrix":
        return featureSettings.feature_matrix !== "false" ? (
          <Matrix
            tasks={tasks}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            onUpdateTask={handleUpdateTask}
            selectedTaskId={selectedTaskId}
          />
        ) : null;
      case "filter":
        return selectedFilterId ? (
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
          />
        ) : null;
      case "plugin-view": {
        const viewInfo = pluginViews.find((v) => v.id === selectedPluginViewId);
        return selectedPluginViewId ? (
          <PluginView viewId={selectedPluginViewId} viewInfo={viewInfo} />
        ) : (
          <p className="text-on-surface-muted">No plugin view selected.</p>
        );
      }
      case "ai-chat":
        return (
          <AIChat onOpenSettings={() => handleOpenSettingsTab("ai")} onSelectTask={handleSelectTask} />
        );
      case "dopamine-menu":
        return (
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
          />
        );
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
