import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
import { Matrix } from "./views/Matrix.js";
import { Calendar } from "./views/Calendar.js";
import { FiltersLabels } from "./views/FiltersLabels.js";
import { FilterView } from "./views/FilterView.js";
import { TaskPage } from "./views/TaskPage.js";
import { ChordIndicator } from "./components/ChordIndicator.js";
import { Breadcrumb, type BreadcrumbItem } from "./components/Breadcrumb.js";
import type { SettingsTab } from "./views/Settings.js";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu.js";
import {
  Pencil, Check, Undo2, Trash2, Flag, FolderInput,
  Calendar as CalendarIcon, Bell, ArrowUpRight, Copy, Link,
  Tag as TagIcon, ListPlus, Lightbulb, XCircle, CircleDot,
} from "lucide-react";
import { DatePicker } from "./components/DatePicker.js";
import type { Project as ProjectType, Section, TaskComment, TaskActivity } from "../core/types.js";
import { api } from "./api/index.js";
import { toDateKey } from "../utils/format-date.js";
import { SkeletonTaskList } from "./components/Skeleton.js";
import { QuickAddModal } from "./components/QuickAddModal.js";
import { OnboardingModal } from "./components/OnboardingModal.js";

import { BlockedTaskIdsContext } from "./context/BlockedTaskIdsContext.js";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "saydo.ui.sidebar.collapsed";

function AppContent() {
  // ── Routing ──
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
  const [savedFilters, setSavedFilters] = useState<Array<{ id: string; name: string; query: string; color?: string }>>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [taskComments, setTaskComments] = useState<TaskComment[]>([]);
  const [taskActivity, setTaskActivity] = useState<TaskActivity[]>([]);
  const [blockedTaskIds, setBlockedTaskIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{
    taskId: string;
    position: { x: number; y: number };
  } | null>(null);
  const [customDatePicker, setCustomDatePicker] = useState<{
    taskId: string;
    mode: "dueDate" | "reminder";
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
  const { dataMutationCount, setFocusedTaskId } = useAIContext();

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

  const fetchBlockedTaskIds = useCallback(async () => {
    try {
      const relations = await api.listTaskRelations();
      const blocked = new Set<string>();
      for (const r of relations) {
        blocked.add(r.relatedTaskId);
      }
      setBlockedTaskIds(blocked);
    } catch {
      // Non-critical
    }
  }, []);

  const taskCount = state.tasks.length;
  useEffect(() => {
    fetchProjects();
    fetchTags();
    fetchBlockedTaskIds();
  }, [taskCount, fetchProjects, fetchTags, fetchBlockedTaskIds]);

  // Refresh projects/tags when AI tools mutate them
  useEffect(() => {
    if (dataMutationCount > 0) {
      fetchProjects();
      fetchTags();
    }
  }, [dataMutationCount, fetchProjects, fetchTags]);

  // Sync selected task → AI focused task context
  useEffect(() => {
    setFocusedTaskId(selectedTaskId);
  }, [selectedTaskId, setFocusedTaskId]);

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

  // ── Load saved filters ──
  const fetchSavedFilters = useCallback(async () => {
    try {
      const val = await api.getAppSetting("saved_filters");
      if (val) setSavedFilters(JSON.parse(val));
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => {
    fetchSavedFilters();
  }, [fetchSavedFilters]);

  // ── Close drawer on navigation ──
  useEffect(() => {
    setDrawerOpen(false);
  }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId]);

  // ── Clear selected task on navigation ──
  useEffect(() => {
    setSelectedTaskId(null);
  }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId, setSelectedTaskId]);

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
      await handleUpdateTask(id, { status: "pending", completedAt: null });
    },
    [handleUpdateTask],
  );

  const handleActivateTask = useCallback(
    async (id: string) => {
      await handleUpdateTask(id, { isSomeday: false });
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

  const { createTask } = useTaskContext();

  const handleDuplicateTask = useCallback(
    async (taskId: string) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      await createTask({
        title: `${task.title} (copy)`,
        description: task.description,
        priority: task.priority,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        projectId: task.projectId,
        recurrence: task.recurrence,
        remindAt: task.remindAt,
        tags: task.tags.map((t) => t.name),
        estimatedMinutes: task.estimatedMinutes,
        deadline: task.deadline,
        isSomeday: task.isSomeday,
        sectionId: task.sectionId,
      });
      playSound("create");
    },
    [state.tasks, createTask, playSound],
  );

  const handleCopyTaskLink = useCallback(
    async (taskId: string) => {
      const url = `${window.location.origin}${window.location.pathname}#/task/${taskId}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Link copied to clipboard");
      } catch {
        showToast("Could not copy link");
      }
    },
    [showToast],
  );

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return [];
    const task = state.tasks.find((t) => t.id === contextMenu.taskId);
    if (!task) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = tomorrow.toISOString();
    const nextMonday = new Date(today);
    nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
    const nextMondayISO = nextMonday.toISOString();
    const nextSaturday = new Date(today);
    nextSaturday.setDate(nextSaturday.getDate() + ((6 - nextSaturday.getDay() + 7) % 7 || 7));
    const nextSaturdayISO = nextSaturday.toISOString();

    const dayAbbr = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short" });
    const shortDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

    // ── Due date submenu ──
    const dueDateSubmenu: ContextMenuItem[] = [
      {
        id: "due-today",
        label: "Today",
        shortcut: dayAbbr(today),
        onClick: () => handleUpdateTask(task.id, { dueDate: todayISO, dueTime: false }),
      },
      {
        id: "due-tomorrow",
        label: "Tomorrow",
        shortcut: dayAbbr(tomorrow),
        onClick: () => handleUpdateTask(task.id, { dueDate: tomorrowISO, dueTime: false }),
      },
      {
        id: "due-next-week",
        label: "Next week",
        shortcut: shortDate(nextMonday),
        onClick: () => handleUpdateTask(task.id, { dueDate: nextMondayISO, dueTime: false }),
      },
      {
        id: "due-next-weekend",
        label: "Next weekend",
        shortcut: shortDate(nextSaturday),
        onClick: () => handleUpdateTask(task.id, { dueDate: nextSaturdayISO, dueTime: false }),
      },
    ];
    if (task.dueDate) {
      dueDateSubmenu.push({
        id: "due-none",
        label: "No date",
        onClick: () => handleUpdateTask(task.id, { dueDate: null, dueTime: false }),
      });
    }
    dueDateSubmenu.push({
      id: "due-custom",
      label: "Custom...",
      separator: true,
      onClick: () => {
        setContextMenu(null);
        setCustomDatePicker({ taskId: task.id, mode: "dueDate", position: contextMenu.position });
      },
    });

    // ── Priority submenu ──
    const prioritySubmenu: ContextMenuItem[] = [
      { id: "priority-1", label: "Priority 1", icon: <Flag size={14} className="text-priority-1" />, onClick: () => handleUpdateTask(task.id, { priority: 1 }) },
      { id: "priority-2", label: "Priority 2", icon: <Flag size={14} className="text-priority-2" />, onClick: () => handleUpdateTask(task.id, { priority: 2 }) },
      { id: "priority-3", label: "Priority 3", icon: <Flag size={14} className="text-priority-3" />, onClick: () => handleUpdateTask(task.id, { priority: 3 }) },
      { id: "priority-4", label: "Priority 4", icon: <Flag size={14} className="text-priority-4" />, onClick: () => handleUpdateTask(task.id, { priority: 4 }) },
    ];
    if (task.priority) {
      prioritySubmenu.push({
        id: "priority-none",
        label: "No priority",
        onClick: () => handleUpdateTask(task.id, { priority: null }),
      });
    }

    // ── Reminder submenu ──
    const tomorrowAt9 = new Date(tomorrow);
    tomorrowAt9.setHours(9, 0, 0, 0);
    const nextMondayAt9 = new Date(nextMonday);
    nextMondayAt9.setHours(9, 0, 0, 0);

    const reminderSubmenu: ContextMenuItem[] = [
      {
        id: "remind-30min",
        label: "In 30 minutes",
        onClick: () => handleUpdateTask(task.id, { remindAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
      },
      {
        id: "remind-1hr",
        label: "In 1 hour",
        onClick: () => handleUpdateTask(task.id, { remindAt: new Date(Date.now() + 60 * 60_000).toISOString() }),
      },
      {
        id: "remind-3hr",
        label: "In 3 hours",
        onClick: () => handleUpdateTask(task.id, { remindAt: new Date(Date.now() + 180 * 60_000).toISOString() }),
      },
      {
        id: "remind-tomorrow-9am",
        label: "Tomorrow at 9 AM",
        shortcut: shortDate(tomorrowAt9),
        onClick: () => handleUpdateTask(task.id, { remindAt: tomorrowAt9.toISOString() }),
      },
      {
        id: "remind-next-monday-9am",
        label: "Next Monday at 9 AM",
        shortcut: shortDate(nextMondayAt9),
        onClick: () => handleUpdateTask(task.id, { remindAt: nextMondayAt9.toISOString() }),
      },
    ];
    if (task.remindAt) {
      reminderSubmenu.push({
        id: "remind-none",
        label: "No reminder",
        onClick: () => handleUpdateTask(task.id, { remindAt: null }),
      });
    }
    reminderSubmenu.push({
      id: "remind-custom",
      label: "Custom...",
      separator: true,
      onClick: () => {
        setContextMenu(null);
        setCustomDatePicker({ taskId: task.id, mode: "reminder", position: contextMenu.position });
      },
    });

    // ── Labels/Tags submenu ──
    const taskTagNames = task.tags.map((t) => t.name);
    const labelsSubmenu: ContextMenuItem[] = availableTags.length > 0
      ? availableTags.map((tag) => {
          const hasTag = taskTagNames.includes(tag);
          return {
            id: `tag-${tag}`,
            label: tag,
            icon: hasTag ? <Check size={14} /> : undefined,
            keepOpen: true,
            onClick: () => {
              const newTags = hasTag
                ? taskTagNames.filter((t) => t !== tag)
                : [...taskTagNames, tag];
              handleUpdateTask(task.id, { tags: newTags });
            },
          };
        })
      : [{ id: "no-tags", label: "No labels yet", disabled: true }];

    // ── Build items ──
    const items: ContextMenuItem[] = [
      {
        id: "edit",
        label: "Edit",
        icon: <Pencil size={14} />,
        shortcut: "Ctrl+E",
        onClick: () => handleSelectTask(task.id),
      },
      {
        id: "toggle",
        label: task.status === "completed" ? "Mark incomplete" : "Complete",
        icon: task.status === "completed" ? <Undo2 size={14} /> : <Check size={14} />,
        separator: true,
        onClick: () => handleToggleTask(task.id),
      },
      {
        id: "due-date",
        label: "Due date",
        icon: <CalendarIcon size={14} />,
        submenu: dueDateSubmenu,
      },
      {
        id: "priority",
        label: "Priority",
        icon: <Flag size={14} />,
        submenu: prioritySubmenu,
      },
      {
        id: "reminder",
        label: "Reminder",
        icon: <Bell size={14} />,
        submenu: reminderSubmenu,
      },
      {
        id: "labels",
        label: "Labels",
        icon: <TagIcon size={14} />,
        submenu: labelsSubmenu,
        separator: true,
      },
    ];

    // ── Add subtask ──
    items.push({
      id: "add-subtask",
      label: "Add subtask",
      icon: <ListPlus size={14} />,
      onClick: () => handleSelectTask(task.id),
    });

    // ── Move to project submenu ──
    if (projects.length > 0) {
      items.push({
        id: "move",
        label: "Move to...",
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

    // ── Go to project ──
    if (task.projectId) {
      items.push({
        id: "go-to-project",
        label: "Go to project",
        icon: <ArrowUpRight size={14} />,
        onClick: () => handleNavigate("project", task.projectId!),
      });
    }

    // ── Move to Someday / Remove from Someday ──
    items.push({
      id: "someday",
      label: task.isSomeday ? "Remove from Someday" : "Move to Someday",
      icon: <Lightbulb size={14} />,
      onClick: () => handleUpdateTask(task.id, { isSomeday: !task.isSomeday }),
    });

    // ── Mark as cancelled / Reopen ──
    items.push({
      id: "cancel-reopen",
      label: task.status === "cancelled" ? "Reopen" : "Mark as cancelled",
      icon: task.status === "cancelled" ? <CircleDot size={14} /> : <XCircle size={14} />,
      separator: true,
      onClick: () => handleUpdateTask(task.id, { status: task.status === "cancelled" ? "pending" : "cancelled" }),
    });

    items.push({
      id: "duplicate",
      label: "Duplicate",
      icon: <Copy size={14} />,
      onClick: () => handleDuplicateTask(task.id),
    });
    items.push({
      id: "copy-link",
      label: "Copy link",
      icon: <Link size={14} />,
      separator: true,
      onClick: () => handleCopyTaskLink(task.id),
    });

    items.push({
      id: "delete",
      label: "Delete",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => handleDeleteTask(task.id),
    });

    return items;
  }, [contextMenu, state.tasks, projects, availableTags, handleSelectTask, handleToggleTask, handleUpdateTask, handleDeleteTask, handleDuplicateTask, handleCopyTaskLink, handleNavigate]);

  // Clear context menu on navigation
  useEffect(() => {
    setContextMenu(null);
    setCustomDatePicker(null);
  }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId]);

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
      await handleUpdateTask(taskId, { sectionId });
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
  }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId, clearSelection]);

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

  // ── Smart nudges ──
  const { activeNudges, dismiss: dismissNudge } = useNudges({
    tasks: state.tasks,
    settings: featureSettings,
  });

  // Show one nudge at a time via toast (8s auto-dismiss)
  const shownNudgeRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeNudges.length === 0) {
      shownNudgeRef.current = null;
      return;
    }
    const next = activeNudges[0];
    if (shownNudgeRef.current === next.id) return;
    shownNudgeRef.current = next.id;

    showToast(next.message, {
      label: "Dismiss",
      onClick: () => dismissNudge(next.id),
    });

    // Auto-dismiss after 8 seconds
    const timer = setTimeout(() => dismissNudge(next.id), 8000);
    return () => clearTimeout(timer);
  }, [activeNudges, showToast, dismissNudge]);

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
      case "matrix":
        return "Matrix - Saydo";
      case "filter": {
        const filter = savedFilters.find((f) => f.id === selectedFilterId);
        return filter ? `${filter.name} - Saydo` : "Filter - Saydo";
      }
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
    selectedFilterId,
    savedFilters,
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
      case "matrix":
        return featureSettings.feature_matrix !== "false" ? (
          <Matrix
            tasks={state.tasks}
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
            tasks={state.tasks}
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
          <AIChat onOpenSettings={() => setSettingsOpen(true)} onSelectTask={handleSelectTask} />
        );
      default:
        return null;
    }
  };

  return (
    <BlockedTaskIdsContext.Provider value={blockedTaskIds}>
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
          savedFilters={savedFilters}
          selectedFilterId={selectedFilterId}
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
      {customDatePicker && (() => {
        const pickerTask = state.tasks.find((t) => t.id === customDatePicker.taskId);
        const currentValue = customDatePicker.mode === "dueDate"
          ? pickerTask?.dueDate ?? null
          : pickerTask?.remindAt ?? null;
        return (
          <DatePicker
            value={currentValue}
            onChange={(date) => {
              if (customDatePicker.mode === "dueDate") {
                const dueTime = date ? !date.endsWith("T00:00:00") : false;
                handleUpdateTask(customDatePicker.taskId, { dueDate: date, dueTime });
              } else {
                handleUpdateTask(customDatePicker.taskId, { remindAt: date });
              }
              setCustomDatePicker(null);
            }}
            showTime
            onClose={() => setCustomDatePicker(null)}
            fixedPosition={customDatePicker.position}
          />
        );
      })()}
    </div>
    </BlockedTaskIdsContext.Provider>
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
