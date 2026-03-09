import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Sidebar } from "./components/Sidebar.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { BulkActionBar } from "./components/BulkActionBar.js";
import { BottomNavBar } from "./components/BottomNavBar.js";
import { MobileDrawer } from "./components/MobileDrawer.js";
import { FAB } from "./components/FAB.js";
import { SearchModal } from "./components/SearchModal.js";
import { AddProjectModal } from "./components/AddProjectModal.js";
import { useTaskContext } from "./context/TaskContext.js";
import { usePluginContext } from "./context/PluginContext.js";
import { useAIContext } from "./context/AIContext.js";
import { useVoiceContext } from "./context/VoiceContext.js";
import { useUndoContext } from "./context/UndoContext.js";
import { useGeneralSettings } from "./context/SettingsContext.js";
import { FocusMode } from "./components/FocusMode.js";
import { TemplateSelector } from "./components/TemplateSelector.js";
import { Toast } from "./components/Toast.js";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation.js";
import { useMultiSelect } from "./hooks/useMultiSelect.js";
import { useNudges } from "./hooks/useNudges.js";
import { useReminders } from "./hooks/useReminders.js";
import { useRouting, type View } from "./hooks/useRouting.js";
import { useTaskHandlers } from "./hooks/useTaskHandlers.js";
import { useBulkActions } from "./hooks/useBulkActions.js";
import { useAppShortcuts } from "./hooks/useAppShortcuts.js";
import { useAppCommands } from "./hooks/useAppCommands.js";
import { useIsMobile } from "./hooks/useIsMobile.js";
import { useSoundEffect } from "./hooks/useSoundEffect.js";
import { shortcutManager } from "./shortcutManagerInstance.js";
import { Settings } from "./views/Settings.js";
import { ChordIndicator } from "./components/ChordIndicator.js";
import { Breadcrumb, type BreadcrumbItem } from "./components/Breadcrumb.js";
import type { SettingsTab } from "./views/Settings.js";
import { ContextMenu } from "./components/ContextMenu.js";
import { DatePicker } from "./components/DatePicker.js";
import type { Project as ProjectType, Section, TaskComment, TaskActivity } from "../core/types.js";
import { api } from "./api/index.js";
import { toDateKey } from "../utils/format-date.js";
import { SkeletonTaskList } from "./components/Skeleton.js";
import { QuickAddModal } from "./components/QuickAddModal.js";
import { ExtractTasksModal } from "./components/ExtractTasksModal.js";
import { OnboardingModal } from "./components/OnboardingModal.js";
import { BlockedTaskIdsContext } from "./context/BlockedTaskIdsContext.js";
import { AppProviders } from "./app/AppProviders.js";
import { useTaskContextMenu } from "./app/TaskContextMenu.js";
import { ViewRenderer } from "./app/ViewRenderer.js";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "saydo.ui.sidebar.collapsed";

function AppContent() {
  // ── Routing ──
  const {
    currentView, selectedProjectId, selectedRouteTaskId, selectedPluginViewId,
    selectedFilterId, settingsTab, focusModeOpen, setFocusModeOpen,
    calendarMode, setCalendarMode, handleNavigate, openSettingsTab,
  } = useRouting();

  const { settings: featureSettings } = useGeneralSettings();
  const [projects, setProjects] = useState<ProjectType[]>([]);

  // ── Task handlers ──
  const {
    selectedTaskId, setSelectedTaskId, selectedTask, handleCreateTask,
    handleToggleTask, handleSelectTask, handleCloseDetail, handleUpdateTask,
    handleDeleteTask, handleUpdateDueDate, handleAddSubtask, handleIndent,
    handleOutdent, handleReorder,
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
  const [extractTasksOpen, setExtractTasksOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [savedFilters, setSavedFilters] = useState<Array<{ id: string; name: string; query: string; color?: string }>>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [taskComments, setTaskComments] = useState<TaskComment[]>([]);
  const [taskActivity, setTaskActivity] = useState<TaskActivity[]>([]);
  const [blockedTaskIds, setBlockedTaskIds] = useState<Set<string>>(new Set());

  // ── Context hooks ──
  const { state, refreshTasks } = useTaskContext();
  const { undo, redo, toast, dismissToast, showToast } = useUndoContext();
  const { plugins, commands: pluginCommands, panels, views: pluginViews, executeCommand } = usePluginContext();
  const builtinPluginIds = useMemo(() => new Set(plugins.filter((p) => p.builtin).map((p) => p.id)), [plugins]);
  const voice = useVoiceContext();
  const { dataMutationCount, setFocusedTaskId } = useAIContext();

  // ── Data fetching ──
  const fetchProjects = useCallback(async () => {
    try { const p = await api.listProjects(); setProjects(p); } catch { /* Non-critical */ }
  }, []);

  const fetchTags = useCallback(async () => {
    try { const tags = await api.listTags(); setAvailableTags(tags.map((t) => t.name)); } catch { /* Non-critical */ }
  }, []);

  const fetchBlockedTaskIds = useCallback(async () => {
    try {
      const relations = await api.listTaskRelations();
      const blocked = new Set<string>();
      for (const r of relations) blocked.add(r.relatedTaskId);
      setBlockedTaskIds(blocked);
    } catch { /* Non-critical */ }
  }, []);

  const taskCount = state.tasks.length;
  useEffect(() => { fetchProjects(); fetchTags(); fetchBlockedTaskIds(); }, [taskCount, fetchProjects, fetchTags, fetchBlockedTaskIds]);
  useEffect(() => { if (dataMutationCount > 0) { fetchProjects(); fetchTags(); } }, [dataMutationCount, fetchProjects, fetchTags]);
  useEffect(() => { setFocusedTaskId(selectedTaskId); }, [selectedTaskId, setFocusedTaskId]);
  useEffect(() => { window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0"); }, [sidebarCollapsed]);
  useEffect(() => { api.getAppSetting("onboarding_completed").then((val) => { if (!val) setOnboardingOpen(true); }); }, []);

  const fetchSavedFilters = useCallback(async () => {
    try { const val = await api.getAppSetting("saved_filters"); if (val) setSavedFilters(JSON.parse(val)); } catch { /* non-critical */ }
  }, []);
  useEffect(() => { fetchSavedFilters(); }, [fetchSavedFilters]);
  useEffect(() => { setDrawerOpen(false); }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId]);
  useEffect(() => { setSelectedTaskId(null); }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId, setSelectedTaskId]);

  // Listen for plugin task detail open requests
  useEffect(() => {
    const handler = (e: Event) => {
      const taskId = (e as CustomEvent).detail?.taskId;
      if (taskId) handleSelectTask(taskId);
    };
    window.addEventListener("saydo:open-task-detail", handler);
    return () => window.removeEventListener("saydo:open-task-detail", handler);
  }, [handleSelectTask]);

  // ── Visible tasks ──
  const visibleTasks = useMemo(() => {
    const tasks = state.tasks;
    switch (currentView) {
      case "inbox": return tasks.filter((t) => t.status === "pending" && !t.projectId);
      case "today": { const today = toDateKey(new Date()); return tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today)); }
      case "upcoming": return tasks.filter((t) => t.status === "pending" && t.dueDate).sort((a, b) => (a.dueDate! > b.dueDate! ? 1 : -1));
      case "project": return tasks.filter((t) => t.status === "pending" && t.projectId === selectedProjectId);
      default: return [];
    }
  }, [state.tasks, currentView, selectedProjectId]);

  // ── Badge counts ──
  const inboxTaskCount = useMemo(() => state.tasks.filter((t) => t.status === "pending" && !t.projectId).length, [state.tasks]);
  const todayTaskCount = useMemo(() => { const today = toDateKey(new Date()); return state.tasks.filter((t) => t.status === "pending" && t.dueDate?.startsWith(today)).length; }, [state.tasks]);
  const projectTaskCounts = useMemo(() => { const counts = new Map<string, number>(); for (const t of state.tasks) { if (t.status === "pending" && t.projectId) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1); } return counts; }, [state.tasks]);
  const projectCompletedCounts = useMemo(() => { const counts = new Map<string, number>(); for (const t of state.tasks) { if (t.status === "completed" && t.projectId) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1); } return counts; }, [state.tasks]);

  // ── Handlers ──
  const handleCreateProject = useCallback(async (name: string, color: string, icon: string, parentId: string | null, isFavorite: boolean, viewStyle: "list" | "board" | "calendar") => {
    try { await api.createProject(name, color || undefined, icon || undefined, parentId, isFavorite, viewStyle); fetchProjects(); } catch { /* Non-critical */ }
  }, [fetchProjects]);

  const handleOpenVoice = useCallback(() => { handleNavigate("ai-chat"); if (voice.settings.voiceMode === "off") voice.updateSettings({ voiceMode: "push-to-talk" }); }, [voice, handleNavigate]);
  const handleAddTask = useCallback(() => { const taskViews: View[] = ["inbox", "today", "upcoming", "project"]; if (!taskViews.includes(currentView)) handleNavigate("inbox"); setAddTaskTrigger((n) => n + 1); }, [currentView, handleNavigate]);
  const handleRestoreTask = useCallback(async (id: string) => { await handleUpdateTask(id, { status: "pending", completedAt: null }); }, [handleUpdateTask]);
  const handleActivateTask = useCallback(async (id: string) => { await handleUpdateTask(id, { isSomeday: false }); }, [handleUpdateTask]);

  const { createTask } = useTaskContext();
  const handleDuplicateTask = useCallback(async (taskId: string) => {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    await createTask({ title: `${task.title} (copy)`, description: task.description, priority: task.priority, dueDate: task.dueDate, dueTime: task.dueTime, projectId: task.projectId, recurrence: task.recurrence, remindAt: task.remindAt, tags: task.tags.map((t) => t.name), estimatedMinutes: task.estimatedMinutes, deadline: task.deadline, isSomeday: task.isSomeday, sectionId: task.sectionId });
    playSound("create");
  }, [state.tasks, createTask, playSound]);

  const handleExtractedTasksCreate = useCallback(async (
    tasks: Array<{ title: string; priority: number | null; dueDate: string | null; description: string | null }>,
    projectId: string | null,
  ) => {
    for (const t of tasks) {
      await createTask({
        title: t.title,
        priority: t.priority,
        dueDate: t.dueDate,
        dueTime: false,
        description: t.description,
        projectId,
        tags: [],
      });
    }
    playSound("create");
  }, [createTask, playSound]);

  const handleCopyTaskLink = useCallback(async (taskId: string) => {
    const url = `${window.location.origin}${window.location.pathname}#/task/${taskId}`;
    try { await navigator.clipboard.writeText(url); showToast("Link copied to clipboard"); } catch { showToast("Could not copy link"); }
  }, [showToast]);

  // ── Task context menu ──
  const { contextMenu, setContextMenu, contextMenuItems, customDatePicker, setCustomDatePicker, handleContextMenu } = useTaskContextMenu({
    tasks: state.tasks, projects, availableTags, handleSelectTask, handleToggleTask, handleUpdateTask, handleDeleteTask, handleDuplicateTask, handleCopyTaskLink, handleNavigate,
  });

  useEffect(() => { setContextMenu(null); setCustomDatePicker(null); }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId, setContextMenu, setCustomDatePicker]);

  // ── Sections ──
  const fetchSections = useCallback(async (projectId: string) => { try { const s = await api.listSections(projectId); setSections(s); } catch { setSections([]); } }, []);
  useEffect(() => { if (currentView === "project" && selectedProjectId) fetchSections(selectedProjectId); else setSections([]); }, [currentView, selectedProjectId, fetchSections]);
  const handleCreateSection = useCallback(async (name: string) => { if (!selectedProjectId) return; await api.createSection(selectedProjectId, name); fetchSections(selectedProjectId); }, [selectedProjectId, fetchSections]);
  const handleUpdateSection = useCallback(async (id: string, data: { name?: string; isCollapsed?: boolean }) => { await api.updateSection(id, data); if (selectedProjectId) fetchSections(selectedProjectId); }, [selectedProjectId, fetchSections]);
  const handleDeleteSection = useCallback(async (id: string) => { await api.deleteSection(id); if (selectedProjectId) fetchSections(selectedProjectId); refreshTasks(); }, [selectedProjectId, fetchSections, refreshTasks]);
  const handleMoveTask = useCallback(async (taskId: string, sectionId: string | null) => { await handleUpdateTask(taskId, { sectionId }); }, [handleUpdateTask]);

  // ── Comments & Activity ──
  const fetchCommentsAndActivity = useCallback(async (taskId: string) => {
    try { const [comments, activity] = await Promise.all([api.listTaskComments(taskId), api.listTaskActivity(taskId)]); setTaskComments(comments); setTaskActivity(activity); } catch { setTaskComments([]); setTaskActivity([]); }
  }, []);
  useEffect(() => { if (selectedTask) fetchCommentsAndActivity(selectedTask.id); else { setTaskComments([]); setTaskActivity([]); } }, [selectedTask, fetchCommentsAndActivity]);
  const handleAddComment = useCallback(async (taskId: string, content: string) => { await api.addTaskComment(taskId, content); fetchCommentsAndActivity(taskId); }, [fetchCommentsAndActivity]);
  const handleUpdateComment = useCallback(async (commentId: string, content: string) => { await api.updateTaskComment(commentId, content); if (selectedTask) fetchCommentsAndActivity(selectedTask.id); }, [selectedTask, fetchCommentsAndActivity]);
  const handleDeleteComment = useCallback(async (commentId: string) => { await api.deleteTaskComment(commentId); if (selectedTask) fetchCommentsAndActivity(selectedTask.id); }, [selectedTask, fetchCommentsAndActivity]);

  // ── Multi-select & Bulk ──
  const { selectedIds: multiSelectedIds, handleMultiSelect, clearSelection } = useMultiSelect(visibleTasks.map((t) => t.id));
  useEffect(() => { clearSelection(); }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId, clearSelection]);
  const { handleBulkComplete, handleBulkDelete, handleBulkMoveToProject, handleBulkAddTag } = useBulkActions(multiSelectedIds, clearSelection);

  // ── Keyboard navigation ──
  useKeyboardNavigation({ tasks: visibleTasks, selectedTaskId, onSelect: handleSelectTask, onOpen: handleSelectTask, onClose: handleCloseDetail, enabled: !commandPaletteOpen });

  // ── Reminders ──
  const handleReminder = useCallback((task: { id: string; title: string }) => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Saydo Reminder", { body: task.title });
    playSound("reminder");
    showToast(`Reminder: ${task.title}`, { label: "View", onClick: () => handleSelectTask(task.id) });
  }, [playSound, showToast, handleSelectTask]);
  useReminders({ onReminder: handleReminder, enabled: true });

  // ── Smart nudges ──
  const { activeNudges, dismiss: dismissNudge } = useNudges({ tasks: state.tasks, settings: featureSettings });
  const shownNudgeRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeNudges.length === 0) { shownNudgeRef.current = null; return; }
    const next = activeNudges[0];
    if (shownNudgeRef.current === next.id) return;
    shownNudgeRef.current = next.id;
    showToast(next.message, { label: "Dismiss", onClick: () => dismissNudge(next.id) });
    const timer = setTimeout(() => dismissNudge(next.id), 8000);
    return () => clearTimeout(timer);
  }, [activeNudges, showToast, dismissNudge]);

  // ── Shortcuts & Commands ──
  useAppShortcuts(setCommandPaletteOpen, undo, redo, setSearchOpen, setFocusModeOpen, setQuickAddOpen, handleNavigate, featureSettings.feature_chords !== "false");
  const handleOpenSettings = useCallback(() => { setSettingsOpen(true); }, []);
  const handleOpenSettingsTab = useCallback((tab: SettingsTab) => { openSettingsTab(tab); setSettingsOpen(true); }, [openSettingsTab]);
  const commands = useAppCommands(handleNavigate, handleOpenSettingsTab, setFocusModeOpen, setTemplateSelectorOpen, projects, pluginCommands, executeCommand, setQuickAddOpen, setExtractTasksOpen);

  // ── Task detail nav ──
  const selectedTaskIdx = selectedTask ? visibleTasks.findIndex((t) => t.id === selectedTask.id) : -1;
  const selectedTaskProjectName = useMemo(() => {
    if (!selectedTask) return "Inbox";
    if (selectedTask.projectId) return projects.find((p) => p.id === selectedTask.projectId)?.name ?? "Inbox";
    return "Inbox";
  }, [selectedTask, projects]);

  // ── Document title ──
  const appTitle = useMemo(() => {
    if (focusModeOpen) return "Focus Mode - Saydo";
    switch (currentView) {
      case "inbox": return "Inbox - Saydo";
      case "today": return "Today - Saydo";
      case "upcoming": return "Upcoming - Saydo";
      case "project": { const p = projects.find((p) => p.id === selectedProjectId); return p ? `${p.name} - Saydo` : "Project - Saydo"; }
      case "plugin-view": { const v = pluginViews.find((v) => v.id === selectedPluginViewId); return v ? `${v.name} - Saydo` : "Custom View - Saydo"; }
      case "task": { const t = selectedRouteTaskId ? state.tasks.find((tk) => tk.id === selectedRouteTaskId) : null; return t ? `${t.title} - Saydo` : "Task - Saydo"; }
      case "calendar": { const m = calendarMode ? calendarMode.charAt(0).toUpperCase() + calendarMode.slice(1) : "Week"; return `Calendar (${m}) - Saydo`; }
      case "filters-labels": return "Filters & Labels - Saydo";
      case "completed": return "Completed - Saydo";
      case "cancelled": return "Cancelled - Saydo";
      case "someday": return "Someday / Maybe - Saydo";
      case "stats": return "Stats - Saydo";
      case "matrix": return "Matrix - Saydo";
      case "filter": { const f = savedFilters.find((f) => f.id === selectedFilterId); return f ? `${f.name} - Saydo` : "Filter - Saydo"; }
      case "ai-chat": return "AI Chat - Saydo";
      default: return "Saydo";
    }
  }, [focusModeOpen, currentView, projects, selectedProjectId, selectedRouteTaskId, state.tasks, pluginViews, selectedPluginViewId, selectedFilterId, savedFilters, calendarMode]);

  useEffect(() => { document.title = appTitle; }, [appTitle]);

  return (
    <BlockedTaskIdsContext.Provider value={blockedTaskIds}>
    <div className="flex flex-col h-screen bg-surface text-on-surface pb-[--height-bottom-nav] md:pb-0">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg focus:text-sm">
        Skip to main content
      </a>
      <div className="flex flex-1 overflow-hidden">
        <div className="hidden md:flex">
          <Sidebar currentView={currentView} onNavigate={handleNavigate} onOpenSettings={handleOpenSettings}
            projects={projects} selectedProjectId={selectedProjectId} panels={panels} pluginViews={pluginViews}
            selectedPluginViewId={selectedPluginViewId} collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed((v) => !v)} projectTaskCounts={projectTaskCounts}
            projectCompletedCounts={projectCompletedCounts} onAddTask={handleAddTask} onSearch={() => setSearchOpen(true)}
            inboxCount={inboxTaskCount} todayCount={todayTaskCount} onOpenProjectModal={() => setProjectModalOpen(true)}
            builtinPluginIds={builtinPluginIds} savedFilters={savedFilters} selectedFilterId={selectedFilterId} />
        </div>
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto p-3 md:p-6 flex flex-col">
         <div className="max-w-7xl w-full mx-auto flex-1 flex flex-col">
          <BulkActionBar selectedCount={multiSelectedIds.size} onCompleteAll={handleBulkComplete} onDeleteAll={handleBulkDelete}
            onMoveToProject={handleBulkMoveToProject} onAddTag={handleBulkAddTag} onClear={clearSelection} projects={projects} />
          {state.loading ? <SkeletonTaskList /> : state.error ? (
            <p role="alert" className="text-error">Error: {state.error}</p>
          ) : (
            <ErrorBoundary key={`${currentView}-${selectedProjectId ?? ""}-${selectedPluginViewId ?? ""}`}>
              <div className="animate-fade-in flex-1 flex flex-col">
                {(currentView === "project" || currentView === "task") && (
                  <Breadcrumb items={(() => {
                    const items: BreadcrumbItem[] = [];
                    if (currentView === "project") {
                      items.push({ label: "Projects", onClick: () => handleNavigate("inbox") });
                      const project = projects.find((p) => p.id === selectedProjectId);
                      if (project) items.push({ label: project.name });
                    } else if (currentView === "task") {
                      const routeTask = selectedRouteTaskId ? state.tasks.find((t) => t.id === selectedRouteTaskId) : null;
                      if (routeTask?.projectId) { const project = projects.find((p) => p.id === routeTask.projectId); if (project) items.push({ label: project.name, onClick: () => handleNavigate("project", project.id) }); }
                      if (routeTask) items.push({ label: routeTask.title });
                    }
                    return items;
                  })()} />
                )}
                <ViewRenderer
                  currentView={currentView} tasks={state.tasks} projects={projects}
                  selectedProjectId={selectedProjectId} selectedRouteTaskId={selectedRouteTaskId}
                  selectedPluginViewId={selectedPluginViewId} selectedFilterId={selectedFilterId}
                  selectedTaskId={selectedTaskId} multiSelectedIds={multiSelectedIds}
                  featureSettings={featureSettings} pluginViews={pluginViews}
                  calendarMode={calendarMode} setCalendarMode={setCalendarMode}
                  sections={sections} availableTags={availableTags} addTaskTrigger={addTaskTrigger}
                  handleCreateTask={handleCreateTask} handleToggleTask={handleToggleTask}
                  handleSelectTask={handleSelectTask} handleUpdateTask={handleUpdateTask}
                  handleDeleteTask={handleDeleteTask} handleMultiSelect={handleMultiSelect}
                  handleReorder={handleReorder} handleAddSubtask={handleAddSubtask}
                  handleUpdateDueDate={handleUpdateDueDate} handleContextMenu={handleContextMenu}
                  handleNavigate={handleNavigate} handleRestoreTask={handleRestoreTask}
                  handleActivateTask={handleActivateTask} handleCreateSection={handleCreateSection}
                  handleUpdateSection={handleUpdateSection} handleDeleteSection={handleDeleteSection}
                  handleMoveTask={handleMoveTask} setSettingsOpen={setSettingsOpen} />
              </div>
            </ErrorBoundary>
          )}
         </div>
        </main>
      </div>

      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Sidebar currentView={currentView} onNavigate={handleNavigate}
          onOpenSettings={() => { setDrawerOpen(false); handleOpenSettings(); }}
          projects={projects} selectedProjectId={selectedProjectId} panels={panels} pluginViews={pluginViews}
          selectedPluginViewId={selectedPluginViewId} collapsed={false} projectTaskCounts={projectTaskCounts}
          projectCompletedCounts={projectCompletedCounts}
          onAddTask={() => { setDrawerOpen(false); handleAddTask(); }}
          onSearch={() => { setDrawerOpen(false); setSearchOpen(true); }}
          inboxCount={inboxTaskCount} todayCount={todayTaskCount}
          onOpenProjectModal={() => { setDrawerOpen(false); setProjectModalOpen(true); }}
          builtinPluginIds={builtinPluginIds} savedFilters={savedFilters} selectedFilterId={selectedFilterId} />
      </MobileDrawer>

      {isMobile && (
        <>
          <FAB onClick={handleAddTask} />
          <BottomNavBar currentView={currentView} onNavigate={handleNavigate}
            onMenuOpen={() => setDrawerOpen(true)} onOpenVoice={handleOpenVoice}
            inboxCount={inboxTaskCount} todayCount={todayTaskCount} />
        </>
      )}

      {selectedTask && currentView !== "task" && (
        <TaskDetailPanel task={selectedTask} allTasks={state.tasks} onUpdate={handleUpdateTask}
          onDelete={handleDeleteTask} onClose={handleCloseDetail} onIndent={handleIndent} onOutdent={handleOutdent}
          onSelect={handleSelectTask} onAddSubtask={handleAddSubtask} onToggleSubtask={handleToggleTask}
          onReorder={handleReorder}
          onNavigatePrev={selectedTaskIdx > 0 ? () => handleSelectTask(visibleTasks[selectedTaskIdx - 1].id) : undefined}
          onNavigateNext={selectedTaskIdx >= 0 && selectedTaskIdx < visibleTasks.length - 1 ? () => handleSelectTask(visibleTasks[selectedTaskIdx + 1].id) : undefined}
          onOpenFullPage={(id) => handleNavigate("task", id)}
          hasPrev={selectedTaskIdx > 0} hasNext={selectedTaskIdx >= 0 && selectedTaskIdx < visibleTasks.length - 1}
          projectName={selectedTaskProjectName} availableTags={availableTags}
          comments={taskComments} activity={taskActivity}
          onAddComment={handleAddComment} onUpdateComment={handleUpdateComment} onDeleteComment={handleDeleteComment} />
      )}
      {settingsOpen && <Settings activeTab={settingsTab} onClose={() => setSettingsOpen(false)} />}
      {focusModeOpen && <FocusMode tasks={state.tasks.filter((t) => t.status === "pending")} onComplete={handleToggleTask} onClose={() => setFocusModeOpen(false)} />}
      <TemplateSelector open={templateSelectorOpen} onClose={() => setTemplateSelectorOpen(false)} onTaskCreated={() => { refreshTasks(); setTemplateSelectorOpen(false); }} />
      <div className="hidden md:block"><StatusBar /></div>
      <CommandPalette commands={commands} isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      {featureSettings.feature_chords !== "false" && <ChordIndicator />}
      <SearchModal isOpen={searchOpen} onClose={() => setSearchOpen(false)} tasks={state.tasks} projects={projects} onSelectTask={handleSelectTask} />
      <AddProjectModal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} onSubmit={handleCreateProject} projects={projects} />
      <QuickAddModal open={quickAddOpen} onClose={() => setQuickAddOpen(false)} onCreateTask={handleCreateTask} />
      <ExtractTasksModal open={extractTasksOpen} onClose={() => setExtractTasksOpen(false)} projects={projects} onCreateTasks={handleExtractedTasksCreate} />
      <OnboardingModal open={onboardingOpen} onComplete={() => { setOnboardingOpen(false); api.setAppSetting("onboarding_completed", "true"); }} />
      {toast && <Toast message={toast.message} actionLabel={toast.actionLabel} onAction={toast.onAction} onDismiss={dismissToast} />}
      {contextMenu && contextMenuItems.length > 0 && <ContextMenu items={contextMenuItems} position={contextMenu.position} onClose={() => setContextMenu(null)} />}
      {customDatePicker && (() => {
        const pickerTask = state.tasks.find((t) => t.id === customDatePicker.taskId);
        const currentValue = customDatePicker.mode === "dueDate" ? pickerTask?.dueDate ?? null : pickerTask?.remindAt ?? null;
        return (
          <DatePicker value={currentValue} onChange={(date) => {
            if (customDatePicker.mode === "dueDate") { const dueTime = date ? !date.endsWith("T00:00:00") : false; handleUpdateTask(customDatePicker.taskId, { dueDate: date, dueTime }); }
            else handleUpdateTask(customDatePicker.taskId, { remindAt: date });
            setCustomDatePicker(null);
          }} showTime onClose={() => setCustomDatePicker(null)} fixedPosition={customDatePicker.position} />
        );
      })()}
    </div>
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
