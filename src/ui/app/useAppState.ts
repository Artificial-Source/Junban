import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useTaskContext } from "../context/TaskContext.js";
import { usePluginContext } from "../context/PluginContext.js";
import { useUndoContext } from "../context/UndoContext.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { useIsMobile } from "../hooks/useIsMobile.js";
import { useSoundEffect } from "../hooks/useSoundEffect.js";
import { useNudges } from "../hooks/useNudges.js";
import { useGlobalShortcut } from "../hooks/useGlobalShortcut.js";
import { useQuickCaptureWindow } from "../hooks/useQuickCaptureWindow.js";
import { listTaskRelations } from "../api/tasks.js";
import { listProjects, listTags } from "../api/projects.js";
import { listSections } from "../api/sections.js";
import { listTaskActivity, listTaskComments } from "../api/comments.js";
import { getAppSetting } from "../api/settings.js";
import { toDateKey } from "../../utils/format-date.js";
import { isTauri } from "../../utils/tauri.js";
import { AI_DATA_MUTATED_EVENT } from "../context/ai-events.js";
import type {
  Project as ProjectType,
  Section,
  TaskComment,
  TaskActivity,
} from "../../core/types.js";
import type { View, CalendarMode } from "../hooks/useRouting.js";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "junban.ui.sidebar.collapsed";

/**
 * Encapsulates all app-level UI state, data fetching, and computed values.
 * Consumes context hooks and returns everything AppContent needs.
 */
export function useAppState(routing: {
  currentView: View;
  selectedProjectId: string | null;
  selectedRouteTaskId: string | null;
  selectedPluginViewId: string | null;
  selectedFilterId: string | null;
  focusModeOpen: boolean;
  calendarMode: CalendarMode | null;
}) {
  const {
    currentView,
    selectedProjectId,
    selectedRouteTaskId,
    selectedPluginViewId,
    selectedFilterId,
    focusModeOpen,
    calendarMode,
  } = routing;

  const { settings: featureSettings } = useGeneralSettings();
  const [projects, setProjects] = useState<ProjectType[]>([]);

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
  const [savedFilters, setSavedFilters] = useState<
    Array<{ id: string; name: string; query: string; color?: string }>
  >([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [taskComments, setTaskComments] = useState<TaskComment[]>([]);
  const [taskActivity, setTaskActivity] = useState<TaskActivity[]>([]);
  const [blockedTaskIds, setBlockedTaskIds] = useState<Set<string>>(new Set());

  // ── Context hooks ──
  const { state, refreshTasks, createTask } = useTaskContext();
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

  // ── Data fetching ──
  const fetchProjects = useCallback(async () => {
    try {
      const p = await listProjects();
      setProjects(p);
    } catch {
      /* Non-critical */
    }
  }, []);

  const fetchTags = useCallback(async () => {
    try {
      const tags = await listTags();
      setAvailableTags(tags.map((t) => t.name));
    } catch {
      /* Non-critical */
    }
  }, []);

  const fetchBlockedTaskIds = useCallback(async () => {
    try {
      const relations = await listTaskRelations();
      const blocked = new Set<string>();
      for (const r of relations) blocked.add(r.relatedTaskId);
      setBlockedTaskIds(blocked);
    } catch {
      /* Non-critical */
    }
  }, []);

  const taskCount = state.tasks.length;
  useEffect(() => {
    fetchProjects();
    fetchTags();
    fetchBlockedTaskIds();
  }, [taskCount, fetchProjects, fetchTags, fetchBlockedTaskIds]);
  useEffect(() => {
    const handleAIDataMutation = () => {
      fetchProjects();
      fetchTags();
    };

    window.addEventListener(AI_DATA_MUTATED_EVENT, handleAIDataMutation);
    return () => window.removeEventListener(AI_DATA_MUTATED_EVENT, handleAIDataMutation);
  }, [fetchProjects, fetchTags]);
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);
  useEffect(() => {
    getAppSetting("onboarding_completed").then((val) => {
      if (!val) setOnboardingOpen(true);
    });
  }, []);

  const fetchSavedFilters = useCallback(async () => {
    try {
      const val = await getAppSetting("saved_filters");
      if (val) setSavedFilters(JSON.parse(val));
    } catch {
      /* non-critical */
    }
  }, []);
  useEffect(() => {
    fetchSavedFilters();
  }, [fetchSavedFilters]);
  useEffect(() => {
    setDrawerOpen(false);
  }, [currentView, selectedProjectId, selectedPluginViewId, selectedFilterId]);

  const fetchSections = useCallback(async (projectId: string) => {
    try {
      const s = await listSections(projectId);
      setSections(s);
    } catch {
      setSections([]);
    }
  }, []);
  useEffect(() => {
    if (currentView === "project" && selectedProjectId) fetchSections(selectedProjectId);
    else setSections([]);
  }, [currentView, selectedProjectId, fetchSections]);

  const fetchCommentsAndActivity = useCallback(async (taskId: string) => {
    try {
      const [comments, activity] = await Promise.all([
        listTaskComments(taskId),
        listTaskActivity(taskId),
      ]);
      setTaskComments(comments);
      setTaskActivity(activity);
    } catch {
      setTaskComments([]);
      setTaskActivity([]);
    }
  }, []);

  // ── Visible tasks ──
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
      if (t.status === "pending" && t.projectId)
        counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
    }
    return counts;
  }, [state.tasks]);
  const projectCompletedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of state.tasks) {
      if (t.status === "completed" && t.projectId)
        counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
    }
    return counts;
  }, [state.tasks]);

  // ── Smart nudges ──
  const { activeNudges, dismiss: dismissNudge } = useNudges({
    tasks: state.tasks,
    settings: featureSettings,
  });
  const shownNudgeRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeNudges.length === 0) {
      shownNudgeRef.current = null;
      return;
    }
    const next = activeNudges[0];
    if (shownNudgeRef.current === next.id) return;
    shownNudgeRef.current = next.id;
    showToast(next.message, { label: "Dismiss", onClick: () => dismissNudge(next.id) });
    const timer = setTimeout(() => dismissNudge(next.id), 8000);
    return () => clearTimeout(timer);
  }, [activeNudges, showToast, dismissNudge]);

  // ── Global Quick Capture (Tauri only) ──
  const { showWindow: showCaptureWindow } = useQuickCaptureWindow();

  useGlobalShortcut(
    featureSettings.quick_capture_hotkey,
    showCaptureWindow,
    featureSettings.quick_capture_enabled === "true" && isTauri(),
  );

  // ── Document title ──
  const appTitle = useMemo(() => {
    if (focusModeOpen) return "Focus Mode - Junban";
    switch (currentView) {
      case "inbox":
        return "Inbox - Junban";
      case "today":
        return "Today - Junban";
      case "upcoming":
        return "Upcoming - Junban";
      case "project": {
        const p = projects.find((p) => p.id === selectedProjectId);
        return p ? `${p.name} - Junban` : "Project - Junban";
      }
      case "plugin-view": {
        const v = pluginViews.find((v) => v.id === selectedPluginViewId);
        return v ? `${v.name} - Junban` : "Custom View - Junban";
      }
      case "task": {
        const t = selectedRouteTaskId
          ? state.tasks.find((tk) => tk.id === selectedRouteTaskId)
          : null;
        return t ? `${t.title} - Junban` : "Task - Junban";
      }
      case "calendar": {
        const m = calendarMode
          ? calendarMode.charAt(0).toUpperCase() + calendarMode.slice(1)
          : "Week";
        return `Calendar (${m}) - Junban`;
      }
      case "filters-labels":
        return "Filters & Labels - Junban";
      case "completed":
        return "Completed - Junban";
      case "cancelled":
        return "Cancelled - Junban";
      case "someday":
        return "Someday / Maybe - Junban";
      case "stats":
        return "Stats - Junban";
      case "matrix":
        return "Matrix - Junban";
      case "filter": {
        const f = savedFilters.find((f) => f.id === selectedFilterId);
        return f ? `${f.name} - Junban` : "Filter - Junban";
      }
      case "ai-chat":
        return "AI Chat - Junban";
      case "dopamine-menu":
        return "Quick Wins - Junban";
      default:
        return "Junban";
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

  return {
    // Feature settings
    featureSettings,

    // Data
    projects,
    state,
    refreshTasks,
    createTask,
    availableTags,
    savedFilters,
    sections,
    taskComments,
    setTaskComments,
    taskActivity,
    setTaskActivity,
    blockedTaskIds,
    visibleTasks,

    // Badge counts
    inboxTaskCount,
    todayTaskCount,
    projectTaskCounts,
    projectCompletedCounts,

    // UI state
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

    // Context values
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

    // Fetchers
    fetchProjects,
    fetchSections,
    fetchCommentsAndActivity,
  };
}
