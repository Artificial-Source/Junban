import { useEffect, useMemo, useCallback } from "react";
import { useRouting } from "./hooks/useRouting.js";
import { useTaskHandlers } from "./hooks/useTaskHandlers.js";
import { useMultiSelect } from "./hooks/useMultiSelect.js";
import { useBulkActions } from "./hooks/useBulkActions.js";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation.js";
import { useReminders } from "./hooks/useReminders.js";
import { useAppShortcuts } from "./hooks/useAppShortcuts.js";
import { useAppCommands } from "./hooks/useAppCommands.js";
import { BlockedTaskIdsContext } from "./context/BlockedTaskIdsContext.js";
import type { AppState } from "./context/AppStateContext.js";
import type { SettingsTab } from "./views/Settings.js";
import { shortcutManager } from "./shortcutManagerInstance.js";
import { setAppSetting } from "./api/settings.js";
import { AppProviders } from "./app/AppProviders.js";
import { useTaskContextMenu } from "./app/TaskContextMenu.js";
import { useAppState } from "./app/useAppState.js";
import { useAppHandlers } from "./app/useAppHandlers.js";
import { AppLayout } from "./app/AppLayout.js";
import { AppModals } from "./app/AppModals.js";

function AppContent() {
  // ── Routing ──
  const routing = useRouting();
  const {
    currentView,
    selectedProjectId,
    selectedRouteTaskId,
    selectedPluginViewId,
    selectedFilterId,
    settingsTab,
    focusModeOpen,
    setFocusModeOpen,
    calendarMode,
    setCalendarMode,
    handleNavigate,
    openSettingsTab,
  } = routing;

  // ── App state (data, UI state, computed values) ──
  const appState = useAppState(routing);
  const {
    featureSettings,
    projects,
    state,
    refreshTasks,
    availableTags,
    savedFilters,
    sections,
    taskComments,
    taskActivity,
    blockedTaskIds,
    visibleTasks,
    inboxTaskCount,
    todayTaskCount,
    projectTaskCounts,
    projectCompletedCounts,
    commandPaletteOpen,
    setCommandPaletteOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    isMobile,
    playSound,
    drawerOpen,
    setDrawerOpen,
    settingsOpen,
    setSettingsOpen,
    templateSelectorOpen,
    setTemplateSelectorOpen,
    addTaskTrigger,
    setAddTaskTrigger,
    searchOpen,
    setSearchOpen,
    projectModalOpen,
    setProjectModalOpen,
    quickAddOpen,
    setQuickAddOpen,
    extractTasksOpen,
    setExtractTasksOpen,
    onboardingOpen,
    setOnboardingOpen,
    undo,
    redo,
    toast,
    dismissToast,
    showToast,
    pluginCommands,
    panels,
    pluginViews,
    executeCommand,
    builtinPluginIds,
    fetchProjects,
    fetchSections,
    fetchCommentsAndActivity,
  } = appState;

  // ── Task handlers ──
  const taskHandlers = useTaskHandlers(selectedProjectId, projects);
  const {
    selectedTaskId,
    setSelectedTaskId,
    selectedTask,
    handleCreateTask,
    handleToggleTask,
    handleSelectTask,
    handleCloseDetail,
    handleUpdateTask,
    handleDeleteTask,
    handleUpdateDueDate,
    handleAddSubtask,
    handleIndent,
    handleOutdent,
    handleReorder,
  } = taskHandlers;

  // ── App handlers (projects, sections, comments, etc.) ──
  const handlers = useAppHandlers({
    currentView,
    selectedProjectId,
    handleNavigate,
    handleUpdateTask,
    handleCreateTask,
    handleSelectTask,
    selectedTask,
    showToast,
    playSound,
    fetchProjects,
    fetchSections,
    fetchCommentsAndActivity,
    refreshTasks,
    setAddTaskTrigger,
    setTaskComments: appState.setTaskComments,
    setTaskActivity: appState.setTaskActivity,
    tasks: state.tasks,
  });

  // ── Task context menu ──
  const {
    contextMenu,
    setContextMenu,
    contextMenuItems,
    customDatePicker,
    setCustomDatePicker,
    handleContextMenu,
  } = useTaskContextMenu({
    tasks: state.tasks,
    projects,
    availableTags,
    handleSelectTask,
    handleToggleTask,
    handleUpdateTask,
    handleDeleteTask,
    handleDuplicateTask: handlers.handleDuplicateTask,
    handleCopyTaskLink: handlers.handleCopyTaskLink,
    handleNavigate,
  });

  useEffect(() => {
    setContextMenu(null);
    setCustomDatePicker(null);
  }, [
    currentView,
    selectedProjectId,
    selectedPluginViewId,
    selectedFilterId,
    setContextMenu,
    setCustomDatePicker,
  ]);

  // ── Clear selection on view change ──
  useEffect(() => {
    setSelectedTaskId(null);
  }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId, setSelectedTaskId]);

  // ── Multi-select & Bulk ──
  const {
    selectedIds: multiSelectedIds,
    handleMultiSelect,
    clearSelection,
  } = useMultiSelect(visibleTasks.map((t) => t.id));
  useEffect(() => {
    clearSelection();
  }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId, clearSelection]);
  const { handleBulkComplete, handleBulkDelete, handleBulkMoveToProject, handleBulkAddTag } =
    useBulkActions(multiSelectedIds, clearSelection);

  // ── Keyboard navigation ──
  useKeyboardNavigation({
    tasks: visibleTasks,
    selectedTaskId,
    onSelect: handleSelectTask,
    onOpen: handleSelectTask,
    onClose: handleCloseDetail,
    enabled: !commandPaletteOpen,
  });

  // ── Reminders ──
  const handleReminder = useCallback(
    (task: { id: string; title: string }) => {
      if (typeof Notification !== "undefined" && Notification.permission === "granted")
        new Notification("Junban Reminder", { body: task.title });
      playSound("reminder");
      showToast(`Reminder: ${task.title}`, {
        label: "View",
        onClick: () => handleSelectTask(task.id),
      });
    },
    [playSound, showToast, handleSelectTask],
  );
  useReminders({ onReminder: handleReminder, enabled: true });

  // ── Shortcuts & Commands ──
  useAppShortcuts(
    setCommandPaletteOpen,
    undo,
    redo,
    setSearchOpen,
    setFocusModeOpen,
    setQuickAddOpen,
    handleNavigate,
    featureSettings.feature_chords !== "false",
  );
  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, [setSettingsOpen]);
  const handleOpenSettingsTab = useCallback(
    (tab: SettingsTab) => {
      openSettingsTab(tab);
      setSettingsOpen(true);
    },
    [openSettingsTab, setSettingsOpen],
  );
  const commands = useAppCommands(
    handleNavigate,
    handleOpenSettingsTab,
    setFocusModeOpen,
    setTemplateSelectorOpen,
    projects,
    pluginCommands,
    executeCommand,
    setQuickAddOpen,
    setExtractTasksOpen,
  );

  // ── Task detail nav ──
  const selectedTaskIdx = selectedTask
    ? visibleTasks.findIndex((t) => t.id === selectedTask.id)
    : -1;
  const selectedTaskProjectName = useMemo(() => {
    if (!selectedTask) return "Inbox";
    if (selectedTask.projectId)
      return projects.find((p) => p.id === selectedTask.projectId)?.name ?? "Inbox";
    return "Inbox";
  }, [selectedTask, projects]);

  // ── AppState context value ──
  const appStateValue: AppState = useMemo(
    () => ({
      currentView,
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
      tasks: state.tasks,
    }),
    [
      currentView,
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
      state.tasks,
    ],
  );

  return (
    <BlockedTaskIdsContext.Provider value={blockedTaskIds}>
      <AppLayout
        currentView={currentView}
        selectedProjectId={selectedProjectId}
        selectedRouteTaskId={selectedRouteTaskId}
        selectedPluginViewId={selectedPluginViewId}
        selectedFilterId={selectedFilterId}
        tasks={state.tasks}
        projects={projects}
        availableTags={availableTags}
        loading={state.loading}
        error={state.error}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        panels={panels}
        pluginViews={pluginViews}
        builtinPluginIds={builtinPluginIds}
        savedFilters={savedFilters}
        projectTaskCounts={projectTaskCounts}
        projectCompletedCounts={projectCompletedCounts}
        inboxTaskCount={inboxTaskCount}
        todayTaskCount={todayTaskCount}
        isMobile={isMobile}
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
        multiSelectedIds={multiSelectedIds}
        handleBulkComplete={handleBulkComplete}
        handleBulkDelete={handleBulkDelete}
        handleBulkMoveToProject={handleBulkMoveToProject}
        handleBulkAddTag={handleBulkAddTag}
        clearSelection={clearSelection}
        selectedTask={selectedTask ?? null}
        selectedTaskIdx={selectedTaskIdx}
        selectedTaskProjectName={selectedTaskProjectName}
        visibleTasks={visibleTasks}
        taskComments={taskComments}
        taskActivity={taskActivity}
        handleNavigate={handleNavigate}
        handleOpenSettings={handleOpenSettings}
        handleAddTask={handlers.handleAddTask}
        handleOpenVoice={handlers.handleOpenVoice}
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
        handleRestoreTask={handlers.handleRestoreTask}
        handleActivateTask={handlers.handleActivateTask}
        handleCreateSection={handlers.handleCreateSection}
        handleUpdateSection={handlers.handleUpdateSection}
        handleDeleteSection={handlers.handleDeleteSection}
        handleMoveTask={handlers.handleMoveTask}
        handleCloseDetail={handleCloseDetail}
        handleIndent={handleIndent}
        handleOutdent={handleOutdent}
        handleAddComment={handlers.handleAddComment}
        handleUpdateComment={handlers.handleUpdateComment}
        handleDeleteComment={handlers.handleDeleteComment}
        setCalendarMode={setCalendarMode}
        addTaskTrigger={addTaskTrigger}
        handleOpenSettingsTab={handleOpenSettingsTab}
        setSearchOpen={setSearchOpen}
        setProjectModalOpen={setProjectModalOpen}
        appState={appStateValue}
      >
        <AppModals
          settingsOpen={settingsOpen}
          settingsTab={settingsTab}
          onCloseSettings={() => setSettingsOpen(false)}
          focusModeOpen={focusModeOpen}
          tasks={state.tasks}
          handleToggleTask={handleToggleTask}
          onCloseFocusMode={() => setFocusModeOpen(false)}
          templateSelectorOpen={templateSelectorOpen}
          onCloseTemplateSelector={() => setTemplateSelectorOpen(false)}
          refreshTasks={refreshTasks}
          commands={commands}
          commandPaletteOpen={commandPaletteOpen}
          onCloseCommandPalette={() => setCommandPaletteOpen(false)}
          featureChordsEnabled={featureSettings.feature_chords !== "false"}
          searchOpen={searchOpen}
          onCloseSearch={() => setSearchOpen(false)}
          projects={projects}
          handleSelectTask={handleSelectTask}
          projectModalOpen={projectModalOpen}
          onCloseProjectModal={() => setProjectModalOpen(false)}
          handleCreateProject={handlers.handleCreateProject}
          quickAddOpen={quickAddOpen}
          onCloseQuickAdd={() => setQuickAddOpen(false)}
          handleCreateTask={handleCreateTask}
          extractTasksOpen={extractTasksOpen}
          onCloseExtractTasks={() => setExtractTasksOpen(false)}
          handleExtractedTasksCreate={handlers.handleExtractedTasksCreate}
          onboardingOpen={onboardingOpen}
          onCompleteOnboarding={() => {
            setOnboardingOpen(false);
            setAppSetting("onboarding_completed", "true");
          }}
          handleOpenSettingsTab={handleOpenSettingsTab}
          toast={toast}
          dismissToast={dismissToast}
          contextMenu={contextMenu}
          contextMenuItems={contextMenuItems}
          setContextMenu={setContextMenu}
          customDatePicker={customDatePicker}
          setCustomDatePicker={setCustomDatePicker}
          handleUpdateTask={handleUpdateTask}
        />
      </AppLayout>
    </BlockedTaskIdsContext.Provider>
  );
}

export { shortcutManager };

export function App() {
  return (
    <AppProviders>
      <AppContent />
    </AppProviders>
  );
}
