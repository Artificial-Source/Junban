import { useEffect, useMemo, useCallback, useState, useRef, type SetStateAction } from "react";
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
import {
  getRemoteStatusFailureFallback,
  shouldBlockLocalMutations,
} from "./app/remoteMutationLock.js";
import { api } from "./api/index.js";
import {
  DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT,
  type DesktopRemoteServerStatus,
} from "./api/desktop-server.js";
import { beginNamedPerfSpan, endNamedPerfSpan, markPerf } from "../utils/perf.js";
import { isTauri } from "../utils/tauri.js";

function guardMutationHandler<Args extends unknown[], Result>(
  blocked: boolean,
  onBlocked: () => void,
  action: (...args: Args) => Result,
  fallback: Result,
): (...args: Args) => Result {
  return (...args: Args) => {
    if (blocked) {
      onBlocked();
      return fallback;
    }

    return action(...args);
  };
}

function AppContent() {
  const tauriRuntime = isTauri();

  useEffect(() => {
    markPerf("junban:app-content-mounted");
  }, []);

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
  const [remoteServerRunning, setRemoteServerRunning] = useState(false);
  const [remoteStatusKnown, setRemoteStatusKnown] = useState(!tauriRuntime);
  const remoteStatusKnownRef = useRef(remoteStatusKnown);
  useEffect(() => {
    remoteStatusKnownRef.current = remoteStatusKnown;
  }, [remoteStatusKnown]);

  const mutationsBlocked = shouldBlockLocalMutations(
    tauriRuntime,
    remoteStatusKnown,
    remoteServerRunning,
  );

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
  useReminders({
    onReminder: handleReminder,
    enabled: true,
    clearReminders: !mutationsBlocked,
  });

  // ── Shortcuts & Commands ──
  const handleOpenSettings = useCallback(() => {
    beginNamedPerfSpan("junban:settings-open");
    setSettingsOpen(true);
  }, [setSettingsOpen]);
  const handleOpenSettingsTab = useCallback(
    (tab: SettingsTab) => {
      beginNamedPerfSpan("junban:settings-open");
      openSettingsTab(tab);
      setSettingsOpen(true);
    },
    [openSettingsTab, setSettingsOpen],
  );
  const [blockedMutationToastAt, setBlockedMutationToastAt] = useState(0);
  const showMutationBlockedToast = useCallback(() => {
    const now = Date.now();
    if (now - blockedMutationToastAt < 1500) {
      return;
    }

    setBlockedMutationToastAt(now);
    showToast("Local changes are disabled while remote access is running.", {
      label: "Remote Access",
      onClick: () => handleOpenSettingsTab("data"),
    });
  }, [blockedMutationToastAt, showToast, handleOpenSettingsTab]);

  const applyRemoteServerStatus = useCallback(
    (serverStatus: DesktopRemoteServerStatus) => {
      setRemoteStatusKnown(true);
      setRemoteServerRunning(serverStatus.running);
    },
    [setRemoteStatusKnown, setRemoteServerRunning],
  );

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
    mutationsBlocked,
    onMutationBlocked: showMutationBlockedToast,
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
    sections,
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
    endNamedPerfSpan("junban:route-change", {
      view: currentView,
      projectId: selectedProjectId,
      pluginViewId: selectedPluginViewId,
      filterId: selectedFilterId,
    });
  }, [
    currentView,
    selectedProjectId,
    selectedPluginViewId,
    selectedFilterId,
    setContextMenu,
    setCustomDatePicker,
  ]);

  useAppShortcuts(
    setCommandPaletteOpen,
    undo,
    redo,
    setSearchOpen,
    setFocusModeOpen,
    setQuickAddOpen,
    handleNavigate,
    featureSettings.feature_chords !== "false",
    mutationsBlocked,
    showMutationBlockedToast,
  );

  const requestOpenQuickAdd = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        (value: SetStateAction<boolean>) => setQuickAddOpen(value),
        undefined,
      ),
    [mutationsBlocked, showMutationBlockedToast, setQuickAddOpen],
  );
  const requestOpenFocusMode = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        (value: SetStateAction<boolean>) => setFocusModeOpen(value),
        undefined,
      ),
    [mutationsBlocked, showMutationBlockedToast, setFocusModeOpen],
  );
  const requestOpenTemplateSelector = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        (value: SetStateAction<boolean>) => setTemplateSelectorOpen(value),
        undefined,
      ),
    [mutationsBlocked, showMutationBlockedToast, setTemplateSelectorOpen],
  );
  const requestOpenProjectModal = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        (value: SetStateAction<boolean>) => setProjectModalOpen(value),
        undefined,
      ),
    [mutationsBlocked, showMutationBlockedToast, setProjectModalOpen],
  );
  const requestOpenExtractTasks = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        (value: SetStateAction<boolean>) => setExtractTasksOpen(value),
        undefined,
      ),
    [mutationsBlocked, showMutationBlockedToast, setExtractTasksOpen],
  );
  const commands = useAppCommands(
    handleNavigate,
    handleOpenSettingsTab,
    requestOpenFocusMode,
    requestOpenTemplateSelector,
    projects,
    pluginCommands,
    executeCommand,
    requestOpenQuickAdd,
    requestOpenExtractTasks,
    mutationsBlocked,
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

  useEffect(() => {
    if (!tauriRuntime) {
      return;
    }

    let active = true;
    const handleServerStatusChange = (event: Event) => {
      applyRemoteServerStatus((event as CustomEvent<DesktopRemoteServerStatus>).detail);
    };
    const loadStatus = () => {
      void api
        .getDesktopRemoteServerStatus()
        .then((serverStatus) => {
          if (active) {
            applyRemoteServerStatus(serverStatus);
          }
        })
        .catch((err: unknown) => {
          const failureFallback = getRemoteStatusFailureFallback(remoteStatusKnownRef.current);
          if (active && failureFallback) {
            setRemoteStatusKnown(failureFallback.remoteStatusKnown);
            setRemoteServerRunning(failureFallback.remoteServerRunning);
          }
          console.error("[app] Failed to poll remote server status:", err);
        });
    };

    window.addEventListener(
      DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT,
      handleServerStatusChange as EventListener,
    );
    loadStatus();
    const timer = window.setInterval(loadStatus, 3000);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(
        DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT,
        handleServerStatusChange as EventListener,
      );
    };
  }, [applyRemoteServerStatus, tauriRuntime]);

  useEffect(() => {
    if (!mutationsBlocked) {
      return;
    }

    setCommandPaletteOpen(false);
    setQuickAddOpen(false);
    setProjectModalOpen(false);
    setTemplateSelectorOpen(false);
    setExtractTasksOpen(false);
    setFocusModeOpen(false);
    setContextMenu(null);
    setCustomDatePicker(null);
    setSelectedTaskId(null);
    clearSelection();

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      activeElement.blur();
    }
  }, [
    mutationsBlocked,
    clearSelection,
    setCommandPaletteOpen,
    setContextMenu,
    setCustomDatePicker,
    setExtractTasksOpen,
    setFocusModeOpen,
    setProjectModalOpen,
    setQuickAddOpen,
    setSelectedTaskId,
    setTemplateSelectorOpen,
  ]);

  const guardedHandleCreateTask = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleCreateTask,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleCreateTask],
  );
  const guardedHandleToggleTask = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleToggleTask,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleToggleTask],
  );
  const guardedHandleUpdateTask = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleUpdateTask,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleUpdateTask],
  );
  const guardedHandleDeleteTask = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleDeleteTask,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleDeleteTask],
  );
  const guardedHandleUpdateDueDate = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleUpdateDueDate,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleUpdateDueDate],
  );
  const guardedHandleAddSubtask = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleAddSubtask,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleAddSubtask],
  );
  const guardedHandleIndent = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleIndent,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleIndent],
  );
  const guardedHandleOutdent = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleOutdent,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleOutdent],
  );
  const guardedHandleReorder = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleReorder,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleReorder],
  );
  const guardedHandleBulkComplete = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleBulkComplete,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleBulkComplete],
  );
  const guardedHandleBulkDelete = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleBulkDelete,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleBulkDelete],
  );
  const guardedHandleBulkMoveToProject = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleBulkMoveToProject,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleBulkMoveToProject],
  );
  const guardedHandleBulkAddTag = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handleBulkAddTag,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handleBulkAddTag],
  );
  const guardedHandleAddTask = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleAddTask,
        undefined,
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleAddTask],
  );
  const guardedHandleCreateProject = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleCreateProject,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleCreateProject],
  );
  const guardedHandleUpdateProject = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleUpdateProject,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleUpdateProject],
  );
  const guardedHandleDeleteProject = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleDeleteProject,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleDeleteProject],
  );
  const guardedHandleCreateSection = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleCreateSection,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleCreateSection],
  );
  const guardedHandleUpdateSection = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleUpdateSection,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleUpdateSection],
  );
  const guardedHandleDeleteSection = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleDeleteSection,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleDeleteSection],
  );
  const guardedHandleMoveTask = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleMoveTask,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleMoveTask],
  );
  const guardedHandleAddComment = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleAddComment,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleAddComment],
  );
  const guardedHandleUpdateComment = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleUpdateComment,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleUpdateComment],
  );
  const guardedHandleDeleteComment = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleDeleteComment,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleDeleteComment],
  );
  const guardedHandleExtractedTasksCreate = useMemo(
    () =>
      guardMutationHandler(
        mutationsBlocked,
        showMutationBlockedToast,
        handlers.handleExtractedTasksCreate,
        Promise.resolve(),
      ),
    [mutationsBlocked, showMutationBlockedToast, handlers.handleExtractedTasksCreate],
  );

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
        handleBulkComplete={guardedHandleBulkComplete}
        handleBulkDelete={guardedHandleBulkDelete}
        handleBulkMoveToProject={guardedHandleBulkMoveToProject}
        handleBulkAddTag={guardedHandleBulkAddTag}
        clearSelection={clearSelection}
        selectedTask={selectedTask ?? null}
        selectedTaskIdx={selectedTaskIdx}
        selectedTaskProjectName={selectedTaskProjectName}
        visibleTasks={visibleTasks}
        taskComments={taskComments}
        taskActivity={taskActivity}
        handleNavigate={handleNavigate}
        handleOpenSettings={handleOpenSettings}
        handleAddTask={guardedHandleAddTask}
        handleOpenVoice={handlers.handleOpenVoice}
        handleCreateProject={guardedHandleCreateProject}
        handleUpdateProject={guardedHandleUpdateProject}
        handleDeleteProject={guardedHandleDeleteProject}
        handleCreateTask={guardedHandleCreateTask}
        handleToggleTask={guardedHandleToggleTask}
        handleSelectTask={handleSelectTask}
        handleUpdateTask={guardedHandleUpdateTask}
        handleDeleteTask={guardedHandleDeleteTask}
        handleMultiSelect={handleMultiSelect}
        handleReorder={guardedHandleReorder}
        handleAddSubtask={guardedHandleAddSubtask}
        handleUpdateDueDate={guardedHandleUpdateDueDate}
        handleContextMenu={handleContextMenu}
        handleCreateSection={guardedHandleCreateSection}
        handleUpdateSection={guardedHandleUpdateSection}
        handleDeleteSection={guardedHandleDeleteSection}
        handleMoveTask={guardedHandleMoveTask}
        handleCloseDetail={handleCloseDetail}
        handleIndent={guardedHandleIndent}
        handleOutdent={guardedHandleOutdent}
        handleAddComment={guardedHandleAddComment}
        handleUpdateComment={guardedHandleUpdateComment}
        handleDeleteComment={guardedHandleDeleteComment}
        addTaskTrigger={addTaskTrigger}
        handleOpenSettingsTab={handleOpenSettingsTab}
        setSearchOpen={setSearchOpen}
        setProjectModalOpen={requestOpenProjectModal}
        appState={appStateValue}
        remoteServerRunning={remoteServerRunning}
        mutationsBlocked={mutationsBlocked}
        handleStopRemoteServer={() => {
          void api.stopDesktopRemoteServer().catch((err: unknown) => {
            showToast(err instanceof Error ? err.message : "Could not stop remote access.");
          });
        }}
      >
        <AppModals
          settingsOpen={settingsOpen}
          settingsTab={settingsTab}
          onCloseSettings={() => setSettingsOpen(false)}
          mutationsBlocked={mutationsBlocked}
          focusModeOpen={focusModeOpen}
          tasks={state.tasks}
          handleToggleTask={guardedHandleToggleTask}
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
          handleCreateProject={guardedHandleCreateProject}
          quickAddOpen={quickAddOpen}
          onCloseQuickAdd={() => setQuickAddOpen(false)}
          handleCreateTask={guardedHandleCreateTask}
          extractTasksOpen={extractTasksOpen}
          onCloseExtractTasks={() => setExtractTasksOpen(false)}
          handleExtractedTasksCreate={guardedHandleExtractedTasksCreate}
          onboardingOpen={onboardingOpen}
          onCompleteOnboarding={() => {
            setOnboardingOpen(false);
            // Skip onboarding_completed write when mutations are blocked
            // (onboarding modal already skips preset/theme writes in that mode)
            if (!mutationsBlocked) {
              void setAppSetting("onboarding_completed", "true");
            }
          }}
          handleOpenSettingsTab={handleOpenSettingsTab}
          toast={toast}
          dismissToast={dismissToast}
          contextMenu={contextMenu}
          contextMenuItems={contextMenuItems}
          setContextMenu={setContextMenu}
          customDatePicker={customDatePicker}
          setCustomDatePicker={setCustomDatePicker}
          handleUpdateTask={guardedHandleUpdateTask}
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
