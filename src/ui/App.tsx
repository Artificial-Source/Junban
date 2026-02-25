import { useState, useEffect, useMemo, useCallback } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Sidebar } from "./components/Sidebar.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { BulkActionBar } from "./components/BulkActionBar.js";
import { AIChat } from "./views/AIChat.js";
import { BottomNavBar } from "./components/BottomNavBar.js";
import { MobileDrawer } from "./components/MobileDrawer.js";
import { FAB } from "./components/FAB.js";
import { SearchModal } from "./components/SearchModal.js";
import { AddProjectModal } from "./components/AddProjectModal.js";
import { TaskProvider, useTaskContext } from "./context/TaskContext.js";
import { PluginProvider, usePluginContext } from "./context/PluginContext.js";
import { AIProvider, useAIContext } from "./context/AIContext.js";
import { VoiceProvider, useVoiceContext } from "./context/VoiceContext.js";
import { UndoProvider, useUndoContext } from "./context/UndoContext.js";
import { SettingsProvider, useGeneralSettings } from "./context/SettingsContext.js";
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
import { PluginView } from "./views/PluginView.js";
import { Completed } from "./views/Completed.js";
import { Cancelled } from "./views/Cancelled.js";
import { Someday } from "./views/Someday.js";
import { Stats } from "./views/Stats.js";
import { Calendar } from "./views/Calendar.js";
import { FiltersLabels } from "./views/FiltersLabels.js";
import { TaskPage } from "./views/TaskPage.js";
import { ChordIndicator } from "./components/ChordIndicator.js";
import { Breadcrumb, type BreadcrumbItem } from "./components/Breadcrumb.js";
import type { SettingsTab } from "./views/Settings.js";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu.js";
import { Pencil, Check, Undo2, Trash2, Flag, FolderInput } from "lucide-react";
import type { Project as ProjectType, Section, TaskComment, TaskActivity } from "../core/types.js";
import { api } from "./api/index.js";
import { toDateKey } from "../utils/format-date.js";
import { SkeletonTaskList } from "./components/Skeleton.js";
import { QuickAddModal } from "./components/QuickAddModal.js";
import { OnboardingModal } from "./components/OnboardingModal.js";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "saydo.ui.sidebar.collapsed";

function AppContent() {
  // ── Routing ──
  const {
    currentView,
    selectedProjectId,
    selectedRouteTaskId,
    selectedPluginViewId,
    settingsTab,
    focusModeOpen,
    setFocusModeOpen,
    calendarMode,
    setCalendarMode,
    handleNavigate,
    openSettingsTab,
  } = useRouting();

  // ── Feature toggles ──
  const { settings: featureSettings } = useGeneralSettings();

  // ── Projects state (declared early for useTaskHandlers) ──
  const [projects, setProjects] = useState<ProjectType[]>([]);

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
  } = useTaskHandlers(selectedProjectId, projects);

  // ── UI state ──
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  });
  const isMobile = useIsMobile();
  const playSound = useSoundEffect();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [addTaskTrigger, setAddTaskTrigger] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [taskComments, setTaskComments] = useState<TaskComment[]>([]);
  const [taskActivity, setTaskActivity] = useState<TaskActivity[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    taskId: string;
    position: { x: number; y: number };
  } | null>(null);

  // ── Context hooks ──
  const { state, refreshTasks } = useTaskContext();
  const { undo, redo, toast, dismissToast, showToast } = useUndoContext();
  const {
    plugins,
    commands: pluginCommands,
    panels,
    views: pluginViews,
    executeCommand,
  } = usePluginContext();

  const builtinPluginIds = useMemo(
    () => new Set(plugins.filter((p) => p.builtin).map((p) => p.id)),
    [plugins],
  );
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

  // ── Local storage sync ──
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // ── Onboarding check ──
  useEffect(() => {
    api.getAppSetting("onboarding_completed").then((val) => {
      if (!val) setOnboardingOpen(true);
    });
  }, []);

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
        const today = toDateKey(new Date());
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
    const today = toDateKey(new Date());
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

  const projectCompletedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of state.tasks) {
      if (t.status === "completed" && t.projectId) {
        counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
      }
    }
    return counts;
  }, [state.tasks]);

  // ── Project CRUD handlers ──
  const handleCreateProject = useCallback(
    async (
      name: string,
      color: string,
      icon: string,
      parentId: string | null,
      isFavorite: boolean,
      viewStyle: "list" | "board" | "calendar",
    ) => {
      try {
        await api.createProject(
          name,
          color || undefined,
          icon || undefined,
          parentId,
          isFavorite,
          viewStyle,
        );
        fetchProjects();
      } catch {
        // Non-critical
      }
    },
    [fetchProjects],
  );

  // ── Mobile AI voice handler ──
  const handleOpenVoice = useCallback(() => {
    handleNavigate("ai-chat");
    // Enable push-to-talk if voice is off
    if (voice.settings.voiceMode === "off") {
      voice.updateSettings({ voiceMode: "push-to-talk" });
    }
  }, [voice, handleNavigate]);

  // ── Add task handler for sidebar button ──
  const handleAddTask = useCallback(() => {
    const taskViews: View[] = ["inbox", "today", "upcoming", "project"];
    if (!taskViews.includes(currentView)) {
      handleNavigate("inbox");
    }
    setAddTaskTrigger((n) => n + 1);
  }, [currentView, handleNavigate]);

  // ── Restore / activate handlers for Cancelled & Someday views ──
  const handleRestoreTask = useCallback(
    async (id: string) => {
      await handleUpdateTask(id, { status: "pending", completedAt: null } as any);
    },
    [handleUpdateTask],
  );

  const handleActivateTask = useCallback(
    async (id: string) => {
      await handleUpdateTask(id, { isSomeday: false } as any);
    },
    [handleUpdateTask],
  );

  // ── Context menu ──
  const handleContextMenu = useCallback(
    (taskId: string, position: { x: number; y: number }) => {
      setContextMenu({ taskId, position });
    },
    [],
  );

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return [];
    const task = state.tasks.find((t) => t.id === contextMenu.taskId);
    if (!task) return [];

    const items: ContextMenuItem[] = [
      {
        id: "edit",
        label: "Edit",
        icon: <Pencil size={14} />,
        onClick: () => handleSelectTask(task.id),
      },
      {
        id: "toggle",
        label: task.status === "completed" ? "Mark incomplete" : "Complete",
        icon: task.status === "completed" ? <Undo2 size={14} /> : <Check size={14} />,
        onClick: () => handleToggleTask(task.id),
      },
      {
        id: "priority",
        label: "Priority",
        icon: <Flag size={14} />,
        submenu: [1, 2, 3, 4].map((p) => ({
          id: `priority-${p}`,
          label: `Priority ${p}`,
          onClick: () => handleUpdateTask(task.id, { priority: p }),
        })),
      },
    ];

    if (projects.length > 0) {
      items.push({
        id: "move",
        label: "Move to project",
        icon: <FolderInput size={14} />,
        submenu: [
          {
            id: "move-inbox",
            label: "Inbox",
            onClick: () => handleUpdateTask(task.id, { projectId: null }),
          },
          ...projects.map((p) => ({
            id: `move-${p.id}`,
            label: p.name,
            onClick: () => handleUpdateTask(task.id, { projectId: p.id }),
          })),
        ],
      });
    }

    items.push({
      id: "delete",
      label: "Delete",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => handleDeleteTask(task.id),
    });

    return items;
  }, [contextMenu, state.tasks, projects, handleSelectTask, handleToggleTask, handleUpdateTask, handleDeleteTask]);

  // Clear context menu on navigation
  useEffect(() => {
    setContextMenu(null);
  }, [currentView, selectedProjectId, selectedPluginViewId]);

  // ── Sections ──
  const fetchSections = useCallback(async (projectId: string) => {
    try {
      const s = await api.listSections(projectId);
      setSections(s);
    } catch {
      setSections([]);
    }
  }, []);

  useEffect(() => {
    if (currentView === "project" && selectedProjectId) {
      fetchSections(selectedProjectId);
    } else {
      setSections([]);
    }
  }, [currentView, selectedProjectId, fetchSections]);

  const handleCreateSection = useCallback(
    async (name: string) => {
      if (!selectedProjectId) return;
      await api.createSection(selectedProjectId, name);
      fetchSections(selectedProjectId);
    },
    [selectedProjectId, fetchSections],
  );

  const handleUpdateSection = useCallback(
    async (id: string, data: { name?: string; isCollapsed?: boolean }) => {
      await api.updateSection(id, data);
      if (selectedProjectId) fetchSections(selectedProjectId);
    },
    [selectedProjectId, fetchSections],
  );

  const handleDeleteSection = useCallback(
    async (id: string) => {
      await api.deleteSection(id);
      if (selectedProjectId) fetchSections(selectedProjectId);
      refreshTasks();
    },
    [selectedProjectId, fetchSections, refreshTasks],
  );

  const handleMoveTask = useCallback(
    async (taskId: string, sectionId: string | null) => {
      await handleUpdateTask(taskId, { sectionId } as any);
    },
    [handleUpdateTask],
  );

  // ── Comments & Activity ──
  const fetchCommentsAndActivity = useCallback(async (taskId: string) => {
    try {
      const [comments, activity] = await Promise.all([
        api.listTaskComments(taskId),
        api.listTaskActivity(taskId),
      ]);
      setTaskComments(comments);
      setTaskActivity(activity);
    } catch {
      setTaskComments([]);
      setTaskActivity([]);
    }
  }, []);

  useEffect(() => {
    if (selectedTask) {
      fetchCommentsAndActivity(selectedTask.id);
    } else {
      setTaskComments([]);
      setTaskActivity([]);
    }
  }, [selectedTask, fetchCommentsAndActivity]);

  const handleAddComment = useCallback(
    async (taskId: string, content: string) => {
      await api.addTaskComment(taskId, content);
      fetchCommentsAndActivity(taskId);
    },
    [fetchCommentsAndActivity],
  );

  const handleUpdateComment = useCallback(
    async (commentId: string, content: string) => {
      await api.updateTaskComment(commentId, content);
      if (selectedTask) fetchCommentsAndActivity(selectedTask.id);
    },
    [selectedTask, fetchCommentsAndActivity],
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      await api.deleteTaskComment(commentId);
      if (selectedTask) fetchCommentsAndActivity(selectedTask.id);
    },
    [selectedTask, fetchCommentsAndActivity],
  );

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
      showToast(`Reminder: ${task.title}`, {
        label: "View",
        onClick: () => handleSelectTask(task.id),
      });
    },
    [playSound, showToast, handleSelectTask],
  );

  useReminders({ onReminder: handleReminder, enabled: true });

  // ── Keyboard shortcuts ──
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
    setFocusModeOpen,
    setTemplateSelectorOpen,
    projects,
    pluginCommands,
    executeCommand,
    setQuickAddOpen,
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
      case "calendar": {
        const modeLabel = calendarMode
          ? calendarMode.charAt(0).toUpperCase() + calendarMode.slice(1)
          : "Week";
        return `Calendar (${modeLabel}) - Saydo`;
      }
      case "filters-labels":
        return "Filters & Labels - Saydo";
      case "completed":
        return "Completed - Saydo";
      case "cancelled":
        return "Cancelled - Saydo";
      case "someday":
        return "Someday / Maybe - Saydo";
      case "stats":
        return "Stats - Saydo";
      case "ai-chat":
        return "AI Chat - Saydo";
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
    calendarMode,
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
            onContextMenu={handleContextMenu}
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
            onContextMenu={handleContextMenu}
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
      case "calendar":
        return (
          <Calendar
            tasks={state.tasks}
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
      case "cancelled":
        return featureSettings.feature_cancelled !== "false" ? (
          <Cancelled
            tasks={state.tasks}
            projects={projects}
            onSelectTask={handleSelectTask}
            onRestoreTask={handleRestoreTask}
          />
        ) : null;
      case "someday":
        return featureSettings.feature_someday !== "false" ? (
          <Someday
            tasks={state.tasks}
            onSelectTask={handleSelectTask}
            onActivateTask={handleActivateTask}
          />
        ) : null;
      case "stats":
        return featureSettings.feature_stats !== "false" ? <Stats tasks={state.tasks} /> : null;
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
          <AIChat onOpenSettings={() => setSettingsOpen(true)} onSelectTask={handleSelectTask} />
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
            projectCompletedCounts={projectCompletedCounts}
            onAddTask={handleAddTask}
            onSearch={() => setSearchOpen(true)}
            inboxCount={inboxTaskCount}
            todayCount={todayTaskCount}
            onOpenProjectModal={() => setProjectModalOpen(true)}
            builtinPluginIds={builtinPluginIds}
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
          {state.loading ? (
            <SkeletonTaskList />
          ) : state.error ? (
            <p role="alert" className="text-error">
              Error: {state.error}
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
                        items.push({ label: "Projects", onClick: () => handleNavigate("inbox") });
                        const project = projects.find((p) => p.id === selectedProjectId);
                        if (project) items.push({ label: project.name });
                      } else if (currentView === "task") {
                        const routeTask = selectedRouteTaskId
                          ? state.tasks.find((t) => t.id === selectedRouteTaskId)
                          : null;
                        if (routeTask?.projectId) {
                          const project = projects.find((p) => p.id === routeTask.projectId);
                          if (project) {
                            items.push({
                              label: project.name,
                              onClick: () => handleNavigate("project", project.id),
                            });
                          }
                        }
                        if (routeTask) items.push({ label: routeTask.title });
                      }
                      return items;
                    })()}
                  />
                )}
                {renderView()}
              </div>
            </ErrorBoundary>
          )}
         </div>
        </main>
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
            onOpenVoice={handleOpenVoice}
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
          comments={taskComments}
          activity={taskActivity}
          onAddComment={handleAddComment}
          onUpdateComment={handleUpdateComment}
          onDeleteComment={handleDeleteComment}
        />
      )}
      {settingsOpen && <Settings activeTab={settingsTab} onClose={() => setSettingsOpen(false)} />}
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
      {featureSettings.feature_chords !== "false" && <ChordIndicator />}
      <SearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        tasks={state.tasks}
        projects={projects}
        onSelectTask={handleSelectTask}
      />
      <AddProjectModal
        open={projectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        onSubmit={handleCreateProject}
        projects={projects}
      />
      <QuickAddModal
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onCreateTask={handleCreateTask}
      />
      <OnboardingModal
        open={onboardingOpen}
        onComplete={() => {
          setOnboardingOpen(false);
          api.setAppSetting("onboarding_completed", "true");
        }}
      />
      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={dismissToast}
        />
      )}
      {contextMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
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
