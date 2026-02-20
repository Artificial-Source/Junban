import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Sidebar } from "./components/Sidebar.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { BulkActionBar } from "./components/BulkActionBar.js";
import { RightActionRail } from "./components/RightActionRail.js";
import { BottomNavBar } from "./components/BottomNavBar.js";
import { MobileDrawer } from "./components/MobileDrawer.js";
import { FAB } from "./components/FAB.js";
import { SearchModal } from "./components/SearchModal.js";
import { TaskProvider, useTaskContext } from "./context/TaskContext.js";
import { PluginProvider, usePluginContext } from "./context/PluginContext.js";
import { AIProvider, useAIContext } from "./context/AIContext.js";
import { VoiceProvider, useVoiceContext } from "./context/VoiceContext.js";
import { UndoProvider, useUndoContext } from "./context/UndoContext.js";
import { SettingsProvider } from "./context/SettingsContext.js";
import { AIChatPanel } from "./components/AIChatPanel.js";
import { FocusMode } from "./components/FocusMode.js";
import { TemplateSelector } from "./components/TemplateSelector.js";
import { Toast } from "./components/Toast.js";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation.js";
import { useMultiSelect } from "./hooks/useMultiSelect.js";
import { useReminders } from "./hooks/useReminders.js";
import { useRouting, type View } from "./hooks/useRouting.js";
import { useTaskHandlers } from "./hooks/useTaskHandlers.js";
import { useBulkActions } from "./hooks/useBulkActions.js";
import { useAppShortcuts } from "./hooks/useAppShortcuts.js";
import { useAppCommands } from "./hooks/useAppCommands.js";
import { useIsMobile } from "./hooks/useIsMobile.js";
import { useSoundEffect } from "./hooks/useSoundEffect.js";
import { shortcutManager } from "./shortcutManagerInstance.js";
import { Inbox } from "./views/Inbox.js";
import { Today } from "./views/Today.js";
import { Upcoming } from "./views/Upcoming.js";
import { Project } from "./views/Project.js";
import { Settings } from "./views/Settings.js";
import { PluginStore } from "./views/PluginStore.js";
import { PluginView } from "./views/PluginView.js";
import { Completed } from "./views/Completed.js";
import { FiltersLabels } from "./views/FiltersLabels.js";
import { TaskPage } from "./views/TaskPage.js";
import type { SettingsTab } from "./views/Settings.js";
import type { Project as ProjectType } from "../core/types.js";
import { api } from "./api/index.js";

const AI_SIDEBAR_OPEN_SETTING_KEY = "ui_ai_sidebar_open";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "saydo.ui.sidebar.collapsed";
const AI_CHAT_EXPANDED_STORAGE_KEY = "saydo.ui.ai-chat.expanded";

function AppContent() {
  // ── Routing ──
  const {
    currentView,
    selectedProjectId,
    selectedRouteTaskId,
    selectedPluginViewId,
    settingsTab,
    setSettingsTab,
    pluginStoreSearchQuery,
    setPluginStoreSearchQuery,
    focusModeOpen,
    setFocusModeOpen,
    handleNavigate,
    openSettingsTab,
  } = useRouting();

  // ── Task handlers ──
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
  } = useTaskHandlers(selectedProjectId);

  // ── UI state ──
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AI_CHAT_EXPANDED_STORAGE_KEY) === "1";
  });
  const [chatPanelStateLoaded, setChatPanelStateLoaded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  });
  const isMobile = useIsMobile();
  const playSound = useSoundEffect();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectType[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [addTaskTrigger, setAddTaskTrigger] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);

  // ── Context hooks ──
  const { state, refreshTasks } = useTaskContext();
  const { undo, redo, toast, dismissToast } = useUndoContext();
  const {
    commands: pluginCommands,
    panels,
    views: pluginViews,
    executeCommand,
  } = usePluginContext();
  const voice = useVoiceContext();
  const { dataMutationCount } = useAIContext();

  // ── Data fetching ──
  const fetchProjects = useCallback(async () => {
    try {
      const p = await api.listProjects();
      setProjects(p);
    } catch {
      // Non-critical
    }
  }, []);

  const fetchTags = useCallback(async () => {
    try {
      const tags = await api.listTags();
      setAvailableTags(tags.map((t) => t.name));
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchProjects();
    fetchTags();
  }, [fetchProjects, fetchTags]);

  const taskCount = state.tasks.length;
  useEffect(() => {
    fetchProjects();
    fetchTags();
  }, [taskCount, fetchProjects, fetchTags]);

  // Refresh projects/tags when AI tools mutate them
  useEffect(() => {
    if (dataMutationCount > 0) {
      fetchProjects();
      fetchTags();
    }
  }, [dataMutationCount, fetchProjects, fetchTags]);

  // ── AI chat sidebar persistence ──
  useEffect(() => {
    let mounted = true;
    api
      .getAppSetting(AI_SIDEBAR_OPEN_SETTING_KEY)
      .then((value) => {
        if (!mounted || value === null) return;
        setChatPanelOpen(value === "1" || value.toLowerCase() === "true");
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setChatPanelStateLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!chatPanelStateLoaded) return;
    api.setAppSetting(AI_SIDEBAR_OPEN_SETTING_KEY, chatPanelOpen ? "1" : "0").catch(() => {});
  }, [chatPanelOpen, chatPanelStateLoaded]);

  // ── Local storage sync ──
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(AI_CHAT_EXPANDED_STORAGE_KEY, chatPanelOpen ? "1" : "0");
  }, [chatPanelOpen]);

  // ── Auto-manage LM Studio models ──
  const autoLoadedModelRef = useRef<string | null>(null);
  const { config: aiConfig } = useAIContext();

  useEffect(() => {
    if (!chatPanelStateLoaded) return;
    const autoManage = window.localStorage.getItem("saydo.ai.auto-manage-lmstudio") === "1";
    if (!autoManage || aiConfig?.provider !== "lmstudio" || !aiConfig.model) return;

    if (chatPanelOpen) {
      // Auto-load model when chat opens
      api
        .loadModel("lmstudio", aiConfig.model)
        .then(() => {
          autoLoadedModelRef.current = aiConfig.model;
        })
        .catch(() => {});
    } else if (autoLoadedModelRef.current) {
      // Auto-unload model when chat closes
      const modelToUnload = autoLoadedModelRef.current;
      autoLoadedModelRef.current = null;
      api.unloadModel("lmstudio", modelToUnload).catch(() => {});
    }
  }, [chatPanelOpen, chatPanelStateLoaded, aiConfig]);

  // ── Close drawer on navigation ──
  useEffect(() => {
    setDrawerOpen(false);
  }, [currentView, selectedProjectId, selectedPluginViewId]);

  // ── Clear selected task on navigation ──
  useEffect(() => {
    setSelectedTaskId(null);
  }, [currentView, selectedProjectId, selectedPluginViewId, setSelectedTaskId]);

  // ── Visible tasks for keyboard navigation ──
  const visibleTasks = useMemo(() => {
    const tasks = state.tasks;
    switch (currentView) {
      case "inbox":
        return tasks.filter((t) => t.status === "pending" && !t.projectId);
      case "today": {
        const today = new Date().toISOString().split("T")[0];
        return tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today));
      }
      case "upcoming":
        return tasks
          .filter((t) => t.status === "pending" && t.dueDate)
          .sort((a, b) => (a.dueDate! > b.dueDate! ? 1 : -1));
      case "project":
        return tasks.filter((t) => t.status === "pending" && t.projectId === selectedProjectId);
      default:
        return [];
    }
  }, [state.tasks, currentView, selectedProjectId]);

  // ── Badge counts ──
  const inboxTaskCount = useMemo(
    () => state.tasks.filter((t) => t.status === "pending" && !t.projectId).length,
    [state.tasks],
  );

  const todayTaskCount = useMemo(() => {
    const today = new Date().toISOString().split("T")[0];
    return state.tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today)).length;
  }, [state.tasks]);

  const projectTaskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of state.tasks) {
      if (t.status === "pending" && t.projectId) {
        counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
      }
    }
    return counts;
  }, [state.tasks]);

  // ── Project CRUD handlers ──
  const handleCreateProject = useCallback(
    async (name: string, color: string, icon: string) => {
      try {
        await api.createProject(name, color || undefined, icon || undefined);
        fetchProjects();
      } catch {
        // Non-critical
      }
    },
    [fetchProjects],
  );

  // ── Mobile AI voice handler ──
  const handleOpenVoice = useCallback(() => {
    setChatPanelOpen(true);
    // Enable push-to-talk if voice is off
    if (voice.settings.voiceMode === "off") {
      voice.updateSettings({ voiceMode: "push-to-talk" });
    }
  }, [voice]);

  // ── Add task handler for sidebar button ──
  const handleAddTask = useCallback(() => {
    const taskViews: View[] = ["inbox", "today", "upcoming", "project"];
    if (!taskViews.includes(currentView)) {
      handleNavigate("inbox");
    }
    setAddTaskTrigger((n) => n + 1);
  }, [currentView, handleNavigate]);

  // ── Multi-select ──
  const {
    selectedIds: multiSelectedIds,
    handleMultiSelect,
    clearSelection,
  } = useMultiSelect(visibleTasks.map((t) => t.id));

  // ── Clear multi-selection on navigation ──
  useEffect(() => {
    clearSelection();
  }, [currentView, selectedProjectId, selectedPluginViewId, clearSelection]);

  // ── Bulk actions ──
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
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("Saydo Reminder", { body: task.title });
      }
      playSound("reminder");
    },
    [playSound],
  );

  useReminders({ onReminder: handleReminder, enabled: true });

  // ── Keyboard shortcuts ──
  useAppShortcuts(setCommandPaletteOpen, undo, redo, setSearchOpen);

  // ── Settings modal helpers ──
  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleOpenSettingsTab = useCallback(
    (tab: SettingsTab) => {
      openSettingsTab(tab);
      setSettingsOpen(true);
    },
    [openSettingsTab],
  );

  // ── Command palette commands ──
  const commands = useAppCommands(
    handleNavigate,
    handleOpenSettingsTab,
    setChatPanelOpen,
    setFocusModeOpen,
    setTemplateSelectorOpen,
    projects,
    pluginCommands,
    executeCommand,
  );

  // ── Task detail panel navigation ──
  const selectedTaskIdx = selectedTask
    ? visibleTasks.findIndex((t) => t.id === selectedTask.id)
    : -1;

  const selectedTaskProjectName = useMemo(() => {
    if (!selectedTask) return "Inbox";
    if (selectedTask.projectId) {
      return projects.find((p) => p.id === selectedTask.projectId)?.name ?? "Inbox";
    }
    return "Inbox";
  }, [selectedTask, projects]);

  // ── Document title ──
  const appTitle = useMemo(() => {
    if (focusModeOpen) return "Focus Mode - Saydo";

    switch (currentView) {
      case "inbox":
        return "Inbox - Saydo";
      case "today":
        return "Today - Saydo";
      case "upcoming":
        return "Upcoming - Saydo";
      case "project": {
        const project = projects.find((p) => p.id === selectedProjectId);
        return project ? `${project.name} - Saydo` : "Project - Saydo";
      }
      case "plugin-store":
        return "Plugin Store - Saydo";
      case "plugin-view": {
        const pluginView = pluginViews.find((view) => view.id === selectedPluginViewId);
        return pluginView ? `${pluginView.name} - Saydo` : "Custom View - Saydo";
      }
      case "task": {
        const t = selectedRouteTaskId
          ? state.tasks.find((tk) => tk.id === selectedRouteTaskId)
          : null;
        return t ? `${t.title} - Saydo` : "Task - Saydo";
      }
      case "filters-labels":
        return "Filters & Labels - Saydo";
      case "completed":
        return "Completed - Saydo";
      default:
        return "Saydo";
    }
  }, [
    focusModeOpen,
    currentView,
    projects,
    selectedProjectId,
    selectedRouteTaskId,
    state.tasks,
    pluginViews,
    selectedPluginViewId,
  ]);

  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  // ── View rendering ──
  const renderView = () => {
    switch (currentView) {
      case "inbox":
        return (
          <Inbox
            tasks={state.tasks}
            onCreateTask={handleCreateTask}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            selectedTaskId={selectedTaskId}
            selectedTaskIds={multiSelectedIds}
            onMultiSelect={handleMultiSelect}
            onReorder={handleReorder}
            onAddSubtask={handleAddSubtask}
            onUpdateDueDate={handleUpdateDueDate}
            autoFocusTrigger={addTaskTrigger}
          />
        );
      case "today":
        return (
          <Today
            tasks={state.tasks}
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
            autoFocusTrigger={addTaskTrigger}
          />
        );
      case "upcoming":
        return (
          <Upcoming
            tasks={state.tasks}
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
            tasks={state.tasks}
            onCreateTask={handleCreateTask}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            selectedTaskId={selectedTaskId}
            selectedTaskIds={multiSelectedIds}
            onMultiSelect={handleMultiSelect}
            onReorder={handleReorder}
            onAddSubtask={handleAddSubtask}
            onUpdateDueDate={handleUpdateDueDate}
            autoFocusTrigger={addTaskTrigger}
          />
        );
      }
      case "task": {
        const routeTask = selectedRouteTaskId
          ? state.tasks.find((t) => t.id === selectedRouteTaskId)
          : null;
        if (!routeTask) {
          return <p className="text-on-surface-muted">Task not found.</p>;
        }
        return (
          <TaskPage
            task={routeTask}
            allTasks={state.tasks}
            projects={projects}
            onUpdate={handleUpdateTask}
            onDelete={(id) => {
              handleDeleteTask(id);
              handleNavigate("inbox");
            }}
            onNavigateBack={() => window.history.back()}
            onSelect={(id) => handleNavigate("task", id)}
            onAddSubtask={handleAddSubtask}
            onToggleSubtask={handleToggleTask}
            onReorder={handleReorder}
            availableTags={availableTags}
          />
        );
      }
      case "filters-labels":
        return (
          <FiltersLabels
            tasks={state.tasks}
            onNavigateToFilter={() => {
              handleNavigate("inbox");
            }}
          />
        );
      case "completed":
        return (
          <Completed tasks={state.tasks} projects={projects} onSelectTask={handleSelectTask} />
        );
      case "plugin-store":
        return (
          <PluginStore
            searchQuery={pluginStoreSearchQuery}
            onSearchQueryChange={setPluginStoreSearchQuery}
          />
        );
      case "plugin-view":
        return selectedPluginViewId ? (
          <PluginView viewId={selectedPluginViewId} />
        ) : (
          <p className="text-on-surface-muted">No plugin view selected.</p>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-surface text-on-surface pb-[--height-bottom-nav] md:pb-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg focus:text-sm"
      >
        Skip to main content
      </a>
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
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
            onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
            projectTaskCounts={projectTaskCounts}
            onAddTask={handleAddTask}
            onSearch={() => setSearchOpen(true)}
            inboxCount={inboxTaskCount}
            todayCount={todayTaskCount}
            onCreateProject={handleCreateProject}
          />
        </div>
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto p-3 md:p-6">
          <BulkActionBar
            selectedCount={multiSelectedIds.size}
            onCompleteAll={handleBulkComplete}
            onDeleteAll={handleBulkDelete}
            onMoveToProject={handleBulkMoveToProject}
            onAddTag={handleBulkAddTag}
            onClear={clearSelection}
            projects={projects}
          />
          {state.loading ? (
            <p className="text-on-surface-muted">Loading...</p>
          ) : state.error ? (
            <p role="alert" className="text-error">
              Error: {state.error}
            </p>
          ) : (
            <ErrorBoundary>{renderView()}</ErrorBoundary>
          )}
        </main>
        {chatPanelOpen &&
          (isMobile ? (
            <div className="fixed inset-0 z-50">
              <AIChatPanel
                onClose={() => setChatPanelOpen(false)}
                onOpenSettings={() => {
                  setSettingsOpen(true);
                  setChatPanelOpen(false);
                }}
                onSelectTask={handleSelectTask}
              />
            </div>
          ) : (
            <AIChatPanel
              onClose={() => setChatPanelOpen(false)}
              onOpenSettings={() => {
                setSettingsOpen(true);
                setChatPanelOpen(false);
              }}
              onSelectTask={handleSelectTask}
            />
          ))}
        <div className="hidden md:flex">
          <RightActionRail
            chatOpen={chatPanelOpen}
            onToggleChat={() => setChatPanelOpen((open) => !open)}
            onFocusMode={() => setFocusModeOpen(true)}
          />
        </div>
      </div>

      {/* Mobile drawer */}
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
          onCreateProject={handleCreateProject}
        />
      </MobileDrawer>

      {/* Mobile bottom nav + FAB */}
      {isMobile && (
        <>
          <FAB onClick={handleAddTask} />
          <BottomNavBar
            currentView={currentView}
            onNavigate={handleNavigate}
            onMenuOpen={() => setDrawerOpen(true)}
            onOpenChat={() => setChatPanelOpen(true)}
            onOpenVoice={handleOpenVoice}
            chatOpen={chatPanelOpen}
            inboxCount={inboxTaskCount}
            todayCount={todayTaskCount}
          />
        </>
      )}

      {selectedTask && currentView !== "task" && (
        <TaskDetailPanel
          task={selectedTask}
          allTasks={state.tasks}
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
        />
      )}
      {settingsOpen && (
        <Settings
          activeTab={settingsTab}
          onActiveTabChange={setSettingsTab}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {focusModeOpen && (
        <FocusMode
          tasks={state.tasks.filter((t) => t.status === "pending")}
          onComplete={handleToggleTask}
          onClose={() => setFocusModeOpen(false)}
        />
      )}
      <TemplateSelector
        open={templateSelectorOpen}
        onClose={() => setTemplateSelectorOpen(false)}
        onTaskCreated={() => {
          refreshTasks();
          setTemplateSelectorOpen(false);
        }}
      />
      <div className="hidden md:block">
        <StatusBar />
      </div>
      <CommandPalette
        commands={commands}
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <SearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        tasks={state.tasks}
        projects={projects}
        onSelectTask={handleSelectTask}
      />
      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={dismissToast}
        />
      )}
    </div>
  );
}

export { shortcutManager };

export function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <TaskProvider>
          <PluginProvider>
            <AIProvider>
              <VoiceProvider>
                <UndoProvider>
                  <AppContent />
                </UndoProvider>
              </VoiceProvider>
            </AIProvider>
          </PluginProvider>
        </TaskProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}
