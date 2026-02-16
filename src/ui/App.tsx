import { useState, useEffect, useMemo, useCallback } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Sidebar } from "./components/Sidebar.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { BulkActionBar } from "./components/BulkActionBar.js";
import { RightActionRail } from "./components/RightActionRail.js";
import { TaskProvider, useTaskContext } from "./context/TaskContext.js";
import { PluginProvider, usePluginContext } from "./context/PluginContext.js";
import { AIProvider } from "./context/AIContext.js";
import { UndoProvider, useUndoContext } from "./context/UndoContext.js";
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
const SIDEBAR_COLLAPSED_STORAGE_KEY = "docket.ui.sidebar.collapsed";
const AI_CHAT_EXPANDED_STORAGE_KEY = "docket.ui.ai-chat.expanded";

function AppContent() {
  // ── Routing ──
  const {
    currentView,
    selectedProjectId,
    selectedRouteTaskId,
    selectedPluginViewId,
    inboxQueryText,
    setInboxQueryText,
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
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectType[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [addTaskTrigger, setAddTaskTrigger] = useState(0);

  // ── Context hooks ──
  const { state, refreshTasks } = useTaskContext();
  const { undo, redo, toast, dismissToast } = useUndoContext();
  const {
    commands: pluginCommands,
    panels,
    views: pluginViews,
    executeCommand,
  } = usePluginContext();

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
    return () => { mounted = false; };
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

  // ── Bulk actions ──
  const {
    handleBulkComplete,
    handleBulkDelete,
    handleBulkMoveToProject,
    handleBulkAddTag,
  } = useBulkActions(multiSelectedIds, clearSelection);

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
  const handleReminder = useCallback((task: { id: string; title: string }) => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Docket Reminder", { body: task.title });
    }
  }, []);

  useReminders({ onReminder: handleReminder, enabled: true });

  // ── Keyboard shortcuts ──
  useAppShortcuts(setCommandPaletteOpen, undo, redo);

  // ── Command palette commands ──
  const commands = useAppCommands(
    handleNavigate,
    openSettingsTab,
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
    if (focusModeOpen) return "Focus Mode - Docket";

    switch (currentView) {
      case "inbox":
        return "Inbox - Docket";
      case "today":
        return "Today - Docket";
      case "upcoming":
        return "Upcoming - Docket";
      case "project": {
        const project = projects.find((p) => p.id === selectedProjectId);
        return project ? `${project.name} - Docket` : "Project - Docket";
      }
      case "settings": {
        const tabLabelById: Record<SettingsTab, string> = {
          general: "General",
          ai: "AI Assistant",
          plugins: "Plugins",
          templates: "Templates",
          keyboard: "Keyboard",
          data: "Data",
          about: "About",
        };
        return `${tabLabelById[settingsTab]} Settings - Docket`;
      }
      case "plugin-store":
        return "Plugin Store - Docket";
      case "plugin-view": {
        const pluginView = pluginViews.find((view) => view.id === selectedPluginViewId);
        return pluginView ? `${pluginView.name} - Docket` : "Custom View - Docket";
      }
      case "task": {
        const t = selectedRouteTaskId ? state.tasks.find((tk) => tk.id === selectedRouteTaskId) : null;
        return t ? `${t.title} - Docket` : "Task - Docket";
      }
      case "filters-labels":
        return "Filters & Labels - Docket";
      case "completed":
        return "Completed - Docket";
      default:
        return "Docket";
    }
  }, [focusModeOpen, currentView, projects, selectedProjectId, selectedRouteTaskId, state.tasks, settingsTab, pluginViews, selectedPluginViewId]);

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
            queryText={inboxQueryText}
            onQueryTextChange={setInboxQueryText}
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
            onNavigateToFilter={(query) => {
              setInboxQueryText(query);
              handleNavigate("inbox");
            }}
          />
        );
      case "completed":
        return <Completed tasks={state.tasks} projects={projects} />;
      case "settings":
        return <Settings activeTab={settingsTab} onActiveTabChange={setSettingsTab} />;
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
    <div className="flex flex-col h-screen bg-surface text-on-surface">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg focus:text-sm"
      >
        Skip to main content
      </a>
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          currentView={currentView}
          onNavigate={handleNavigate}
          projects={projects}
          selectedProjectId={selectedProjectId}
          panels={panels}
          pluginViews={pluginViews}
          selectedPluginViewId={selectedPluginViewId}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          projectTaskCounts={projectTaskCounts}
          onAddTask={handleAddTask}
          inboxCount={inboxTaskCount}
          todayCount={todayTaskCount}
        />
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto p-6">
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
        {chatPanelOpen && (
          <AIChatPanel
            onClose={() => setChatPanelOpen(false)}
            onOpenSettings={() => {
              handleNavigate("settings");
              setChatPanelOpen(false);
            }}
          />
        )}
        <RightActionRail
          chatOpen={chatPanelOpen}
          onToggleChat={() => setChatPanelOpen((open) => !open)}
          onFocusMode={() => setFocusModeOpen(true)}
        />
      </div>
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
          onNavigatePrev={selectedTaskIdx > 0 ? () => handleSelectTask(visibleTasks[selectedTaskIdx - 1].id) : undefined}
          onNavigateNext={selectedTaskIdx >= 0 && selectedTaskIdx < visibleTasks.length - 1 ? () => handleSelectTask(visibleTasks[selectedTaskIdx + 1].id) : undefined}
          onOpenFullPage={(id) => handleNavigate("task", id)}
          hasPrev={selectedTaskIdx > 0}
          hasNext={selectedTaskIdx >= 0 && selectedTaskIdx < visibleTasks.length - 1}
          projectName={selectedTaskProjectName}
          availableTags={availableTags}
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
      <StatusBar />
      <CommandPalette
        commands={commands}
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
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
      <TaskProvider>
        <PluginProvider>
          <AIProvider>
            <UndoProvider>
              <AppContent />
            </UndoProvider>
          </AIProvider>
        </PluginProvider>
      </TaskProvider>
    </ErrorBoundary>
  );
}
