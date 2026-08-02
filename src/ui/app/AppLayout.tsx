/**
 * App Layout: full sidebar, all views, modals, SSE, toasts, bulk actions.
 * Preserves the exact legacy shell: responsive sidebar/header/main/skip-link,
 * mobile drawer and bottom nav, task detail panel, command palette, search,
 * quick add, project modals, and Phase 3 planning/focus/reminder surfaces.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { NavigateTarget } from "../hooks/useRouting";
import { useRouting } from "../hooks/useRouting";
import { useWorkspace } from "../context/WorkspaceContext";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  useKeyboardShortcuts,
  ChordIndicator,
  formatShortcutBinding,
  shortcutBindingFor,
  type ShortcutCommand,
} from "../hooks/useKeyboardShortcuts";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useSmartNudges } from "../hooks/useSmartNudges";
import { useReminderDelivery } from "../hooks/useReminderDelivery";
import { Sidebar } from "../components/Sidebar";
import { BottomNavBar } from "../components/BottomNavBar";
import { FAB } from "../components/FAB";
import { MobileDrawer } from "../components/MobileDrawer";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ToastContainer } from "../components/Toast";
import { BulkActionBar } from "../components/BulkActionBar";
import { ViewSkeleton } from "../components/Skeleton";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import { Phase2TaskDetailVisualFixture } from "../components/Phase2TaskDetailVisualFixture";
import { CommandPalette, type Command } from "../components/CommandPalette";
import { SearchModal } from "../components/SearchModal";
import { QuickAddModal } from "../components/QuickAddModal";
import { AddProjectModal } from "../components/AddProjectModal";
import { DailyPlanningModal } from "../components/DailyPlanningModal";
import { DailyReviewModal } from "../components/DailyReviewModal";
import { WeeklyReviewModal } from "../components/WeeklyReviewModal";
import { FocusMode } from "../components/FocusMode";
import { Today } from "../views/Today";
import { Inbox } from "../views/Inbox";
import { Upcoming } from "../views/Upcoming";
import { Someday } from "../views/Someday";
import { Completed } from "../views/Completed";
import { Cancelled } from "../views/Cancelled";
import { Project } from "../views/Project";
import { TaskPage } from "../views/TaskPage";
import { FiltersLabels } from "../views/FiltersLabels";
import { FilterView } from "../views/FilterView";
import { Calendar } from "../views/Calendar";
import { Matrix } from "../views/Matrix";
import { Stats } from "../views/Stats";
import { DopamineMenu } from "../views/DopamineMenu";
import { Timeblocking } from "../views/Timeblocking";
import { SettingsDialog } from "../views/settings/SettingsDialog";
import type { TaskDto } from "../api/client";
import { getTask, hasStoredToken } from "../api/client";
import { detailRefreshFromEvent } from "./detailRefresh";
import { isShellBlocking, isTaskDetailLayerActive, isolateShellSiblings } from "./shellIsolation";
import { shouldEnableAppShortcuts } from "./shortcutGate";
import { isVisualFixture } from "../lib/visualFixture";
import { shouldApplyStartupDefaultView, startScreenFromDefaultView } from "../lib/startupView";
import { shouldPlaySoundEvent, soundEventForTaskEvent } from "../lib/soundPolicy";
import { playSound } from "../lib/sounds";

const MOBILE_DRAWER_ID = "junban-mobile-nav-drawer";

export function AppLayout() {
  // Route-backed overlays replace the pathname and query. Pin explicit fixture
  // identity for this app mount so a visual scene cannot start background work
  // after opening Settings.
  const visualFixtureSearch = useRef(window.location.search).current;
  const phase2VisualFixture = isVisualFixture(visualFixtureSearch, "phase-2");
  const phase3VisualFixture = isVisualFixture(visualFixtureSearch, "phase-3");
  const phase4VisualFixture = isVisualFixture(visualFixtureSearch, "phase-4");
  const anyVisualFixture = new URLSearchParams(visualFixtureSearch).has("visual-fixture");
  const visualFixtureParams = new URLSearchParams(visualFixtureSearch);
  const phase2TaskDetailVisualFixture =
    phase2VisualFixture && visualFixtureParams.get("phase2-detail-fixture") === "1";
  const phase2DetailVisualFixture =
    phase2VisualFixture &&
    (phase2TaskDetailVisualFixture ||
      visualFixtureParams.get("phase2-legacy-today-fixture") === "1");
  const {
    route,
    view,
    navigate,
    settings: settingsLocation,
    settingsOpen,
    closeSettings,
    navigateSettings,
    focusModeOpen,
    setFocusModeOpen,
  } = useRouting();
  const {
    catalog,
    catalogLoading,
    refreshCatalog,
    toasts,
    showToast,
    dismissToast,
    undo,
    redo,
    sseError,
    registerTaskEventHandler,
    settings,
  } = useWorkspace();
  const features = settings?.features;
  // The immutable Phase 3 focus scene predates persisted feature visibility.
  const focusModeEnabled = phase3VisualFixture || (features?.focus_mode_enabled ?? false);
  const dailyPlanningEnabled = features?.daily_planning_enabled ?? true;
  const weeklyReviewEnabled = features?.weekly_review_enabled ?? true;
  const notifications = settings?.notifications;
  const notificationChannels = notifications?.channels;
  const volumePercent = notifications?.volume_percent ?? 70;
  // Reminder presentation: master + reminder flag; channel gate stays in the delivery hook.
  const reminderSoundEnabled =
    (notifications?.sound_enabled ?? false) && (notifications?.reminder_sound ?? true);
  const { completeTask, uncompleteTask, bulkTasks } = useTaskMutations();
  useSmartNudges({ enabled: !phase2VisualFixture && !phase4VisualFixture });
  const startupAppliedRef = useRef(false);

  // First authoritative settings load only: bare `/` uses task_defaults.default_view.
  // Visual fixtures and later navigations (including explicit Today) are left alone.
  useEffect(() => {
    if (!settings) return;
    if (
      !shouldApplyStartupDefaultView({
        pathname: window.location.pathname,
        alreadyApplied: startupAppliedRef.current,
        visualFixture: anyVisualFixture,
      })
    ) {
      return;
    }
    startupAppliedRef.current = true;
    const start = startScreenFromDefaultView(settings.task_defaults.default_view);
    if (!start || start === "today") return;
    navigate(start);
  }, [settings, anyVisualFixture, navigate]);

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useIsMobile();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addTaskTrigger, setAddTaskTrigger] = useState(0);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [planMyDayOpen, setPlanMyDayOpen] = useState(false);
  const [endOfDayOpen, setEndOfDayOpen] = useState(false);
  const [weeklyReviewOpen, setWeeklyReviewOpen] = useState(false);
  const [detailTask, setDetailTask] = useState<TaskDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [focusStartTaskId, setFocusStartTaskId] = useState<string | null>(null);
  const [, setFocusMutationPending] = useState(false);
  const focusMutationPendingRef = useRef(false);
  const multiSelect = useMultiSelect();
  const selectedTaskIdRef = useRef<string | null>(null);
  const taskDetailOpenerRef = useRef<HTMLElement | null>(null);
  const settingsOpenerRef = useRef<HTMLElement | null>(null);
  const settingsWasOpenRef = useRef(settingsOpen);
  selectedTaskIdRef.current = selectedTaskId;

  useEffect(() => {
    const wasOpen = settingsWasOpenRef.current;
    settingsWasOpenRef.current = settingsOpen;
    if (!wasOpen || settingsOpen) return;
    const target = settingsOpenerRef.current;
    queueMicrotask(() => {
      if (!target?.isConnected) return;
      target.focus({ preventScroll: true });
      settingsOpenerRef.current = null;
    });
  }, [settingsOpen]);

  // Isolate only while a real detail overlay/loading cover is up — a bare
  // selectedTaskId after a rejected getTask must not leave the shell locked.
  const taskDetailActive = isTaskDetailLayerActive(selectedTaskId, detailTask, detailLoading);
  const blockingLayerOpen = isShellBlocking({
    drawerOpen,
    quickAddOpen,
    searchOpen,
    paletteOpen,
    projectModalOpen,
    taskDetailActive,
    planMyDayOpen,
    endOfDayOpen,
    weeklyReviewOpen,
    focusModeOpen,
    settingsOpen,
  });

  useReminderDelivery({
    enabled: !anyVisualFixture && hasStoredToken() && !catalogLoading && !!settings,
    onInApp: (reminder) => {
      showToast("info", reminder.title, {
        inverted: true,
        durationMs: 8000,
        href: `/tasks/${reminder.taskId}`,
        hrefLabel: "Open",
      });
    },
    playSound: () => playSound("reminder", volumePercent),
    soundEnabled: reminderSoundEnabled,
    allowedChannels: notificationChannels,
  });

  // Task event sounds use the same committed-event fan-out as detail refresh.
  // Visual fixtures never emit audio.
  useEffect(() => {
    if (anyVisualFixture || !notifications) return;
    return registerTaskEventHandler((event) => {
      const soundEvent = soundEventForTaskEvent(event.event_type);
      if (!soundEvent) return;
      if (
        !shouldPlaySoundEvent(
          {
            sound_enabled: notifications.sound_enabled,
            volume_percent: notifications.volume_percent,
            task_completed_sound: notifications.task_completed_sound,
            task_created_sound: notifications.task_created_sound,
            task_deleted_sound: notifications.task_deleted_sound,
            reminder_sound: notifications.reminder_sound,
            channels: notifications.channels,
          },
          soundEvent,
        )
      ) {
        return;
      }
      void playSound(soundEvent, notifications.volume_percent);
    });
  }, [anyVisualFixture, notifications, registerTaskEventHandler]);

  // Keep every background sibling out of the accessibility and focus trees while
  // a drawer, panel, loading cover, or modal owns interaction. Overlay hosts
  // (detail, modals, toasts) opt out via data-app-overlay.
  useEffect(() => {
    if (!blockingLayerOpen) return;
    const root = rootRef.current;
    if (!root) return;

    let restore: (() => void) | undefined;
    let cancelled = false;
    // Focus traps capture their opener in sibling effects. Isolate in the next
    // microtask so the opener is remembered before `inert` can move focus.
    queueMicrotask(() => {
      if (cancelled) return;
      restore = isolateShellSiblings(root);
    });

    return () => {
      cancelled = true;
      restore?.();
    };
  }, [blockingLayerOpen]);

  // Focus main content on view change and clear multi-select.
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    multiSelect.clear();
    // multiSelect.clear is stable; depend on route only so selection clears once per navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  const loadDetail = useCallback(async (taskId: string, opts?: { showLoading?: boolean }) => {
    if (opts?.showLoading) setDetailLoading(true);
    try {
      const task = await getTask(taskId);
      if (selectedTaskIdRef.current === taskId) {
        setDetailTask(task);
      }
    } catch {
      // Clear selection so the shell never stays locked with no overlay.
      if (selectedTaskIdRef.current === taskId) {
        setDetailTask(null);
        setSelectedTaskId(null);
      }
    } finally {
      if (selectedTaskIdRef.current === taskId) {
        setDetailLoading(false);
      }
    }
  }, []);

  // Load detail when the selected task identity changes. Do not tie this to the
  // global revision — that unmounted the panel and wiped unsaved drafts.
  useEffect(() => {
    if (!selectedTaskId) {
      setDetailTask(null);
      setDetailLoading(false);
      return;
    }
    setDetailTask((prev) => (prev?.id === selectedTaskId ? prev : null));
    void loadDetail(selectedTaskId, { showLoading: true });
  }, [selectedTaskId, loadDetail]);

  // Refresh the open detail only when a task event actually affects it.
  // Catalog-only revisions are ignored so the panel stays mounted with its draft.
  useEffect(() => {
    return registerTaskEventHandler((event) => {
      const action = detailRefreshFromEvent(selectedTaskIdRef.current, event);
      if (action.kind === "snapshot") {
        setDetailTask(action.task);
        setDetailLoading(false);
      } else if (action.kind === "refetch") {
        const id = selectedTaskIdRef.current;
        if (id) void loadDetail(id, { showLoading: false });
      } else if (action.kind === "close") {
        setSelectedTaskId(null);
        setDetailTask(null);
        setDetailLoading(false);
      }
    });
  }, [registerTaskEventHandler, loadDetail]);

  const handleNavigate = useCallback(
    (target: NavigateTarget) => {
      if (typeof target === "object" && target.name === "settings") {
        settingsOpenerRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      navigate(target);
      setDrawerOpen(false);
    },
    [navigate],
  );

  const handleAddTask = useCallback(() => {
    if (isMobile) {
      setQuickAddOpen(true);
    } else {
      setAddTaskTrigger((prev) => prev + 1);
    }
  }, [isMobile]);

  const handleSelectTask = useCallback((id: string) => {
    taskDetailOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedTaskId(id);
  }, []);

  const handleEnterFocusMode = useCallback(
    (taskId?: string) => {
      if (!focusModeEnabled) return;
      setFocusStartTaskId(taskId ?? selectedTaskIdRef.current);
      setSelectedTaskId(null);
      setFocusModeOpen(true);
    },
    [focusModeEnabled, setFocusModeOpen],
  );

  const handleCloseFocusMode = useCallback(() => {
    if (focusMutationPendingRef.current) return;
    setFocusModeOpen(false);
    setFocusStartTaskId(null);
  }, [setFocusModeOpen]);

  const handleOpenFullPage = useCallback(
    (taskId: string) => {
      setSelectedTaskId(null);
      navigate({ name: "task", taskId });
    },
    [navigate],
  );

  // Toggle task (complete/uncomplete based on current status)
  const handleToggleTask = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const task = await getTask(id);
        const result =
          task.status === "completed" ? await uncompleteTask(id) : await completeTask(id);
        return result !== null;
      } catch {
        return false;
      }
    },
    [completeTask, uncompleteTask],
  );

  // Bulk actions
  const handleBulkComplete = useCallback(async () => {
    const ids = [...multiSelect.selectedIds];
    const result = await bulkTasks({ action: { type: "complete" }, task_ids: ids });
    if (result) multiSelect.clear();
    return result !== null;
  }, [multiSelect, bulkTasks]);

  const handleBulkDelete = useCallback(async () => {
    const ids = [...multiSelect.selectedIds];
    const result = await bulkTasks({ action: { type: "delete" }, task_ids: ids });
    if (result) multiSelect.clear();
    return result !== null;
  }, [multiSelect, bulkTasks]);

  const handleBulkMove = useCallback(
    async (projectId: string | null) => {
      const ids = [...multiSelect.selectedIds];
      const result = await bulkTasks({
        action: { type: "move", target: { project_id: projectId, order: "keep" } },
        task_ids: ids,
      });
      if (result) multiSelect.clear();
      return result !== null;
    },
    [multiSelect, bulkTasks],
  );

  const handleBulkTag = useCallback(
    async (tagId: string) => {
      const ids = [...multiSelect.selectedIds];
      const result = await bulkTasks({
        action: { type: "tag", change: { add: [tagId] } },
        task_ids: ids,
      });
      if (result) multiSelect.clear();
      return result !== null;
    },
    [multiSelect, bulkTasks],
  );

  // Settings are applied here only after WorkspaceContext receives an
  // authoritative server snapshot (initial load, save refresh, or SSE resync).
  const shortcut = (action: string, fallback: string) =>
    shortcutBindingFor(settings?.keyboard_shortcuts, action, fallback);

  // Keyboard shortcuts
  const commands: ShortcutCommand[] = [
    {
      id: "quick-add",
      description: "Quick Add",
      binding: shortcut("quick-add", "cmd+a"),
      action: () => setQuickAddOpen(true),
    },
    {
      id: "search",
      description: "Search",
      binding: shortcut("search", "cmd+k"),
      action: () => setSearchOpen(true),
    },
    {
      id: "command-palette",
      description: "Command Palette",
      binding: shortcut("command-palette", "cmd+shift+p"),
      action: () => setPaletteOpen(true),
    },
    {
      id: "new-project",
      description: "New Project",
      binding: shortcut("new-project", "g n"),
      action: () => setProjectModalOpen(true),
    },
    {
      id: "undo",
      description: "Undo",
      binding: shortcut("undo", "cmd+z"),
      action: () => void undo(),
    },
    {
      id: "redo",
      description: "Redo",
      binding: shortcut("redo", "cmd+shift+z"),
      action: () => void redo(),
    },
    {
      id: "today",
      description: "Go to Today",
      binding: shortcut("today", "g t"),
      action: () => handleNavigate("today"),
    },
    {
      id: "inbox",
      description: "Go to Inbox",
      binding: shortcut("inbox", "g i"),
      action: () => handleNavigate("inbox"),
    },
    {
      id: "upcoming",
      description: "Go to Upcoming",
      binding: shortcut("upcoming", "g u"),
      action: () => handleNavigate("upcoming"),
    },
    {
      id: "someday",
      description: "Go to Someday",
      binding: shortcut("someday", "g s"),
      action: () => handleNavigate("someday"),
    },
    {
      id: "completed",
      description: "Go to Completed",
      binding: shortcut("completed", "g c"),
      action: () => handleNavigate("completed"),
    },
    {
      id: "cancelled",
      description: "Go to Cancelled",
      binding: shortcut("cancelled", "g x"),
      action: () => handleNavigate("cancelled"),
    },
    {
      id: "filters",
      description: "Go to Filters & Labels",
      binding: shortcut("filters", "g f"),
      action: () => handleNavigate("filters-labels"),
    },
    ...(!phase2VisualFixture
      ? [
          ...(focusModeEnabled
            ? [
                {
                  id: "focus-mode",
                  description: "Enter Focus Mode",
                  binding: shortcut("focus-mode", "cmd+shift+f"),
                  action: () => handleEnterFocusMode(),
                },
              ]
            : []),
          ...(dailyPlanningEnabled
            ? [
                {
                  id: "plan-my-day",
                  description: "Plan My Day",
                  binding: shortcut("plan-my-day", "g p"),
                  action: () => setPlanMyDayOpen(true),
                },
                {
                  id: "end-of-day",
                  description: "End of Day",
                  binding: shortcut("end-of-day", "g e"),
                  action: () => setEndOfDayOpen(true),
                },
              ]
            : []),
          ...(weeklyReviewEnabled
            ? [
                {
                  id: "weekly-review",
                  description: "Weekly Review",
                  binding: shortcut("weekly-review", "g w"),
                  action: () => setWeeklyReviewOpen(true),
                },
              ]
            : []),
        ]
      : []),
  ];

  const { chord } = useKeyboardShortcuts(
    commands,
    shouldEnableAppShortcuts({
      quickAddOpen,
      searchOpen,
      paletteOpen,
      selectedTaskId,
      projectModalOpen,
      drawerOpen,
      planMyDayOpen,
      endOfDayOpen,
      weeklyReviewOpen,
      focusModeOpen,
      settingsOpen,
    }),
  );

  // Command palette commands
  const paletteCommands: Command[] = [
    {
      id: "quick-add",
      name: "Quick Add Task",
      callback: () => setQuickAddOpen(true),
      hotkey: formatShortcutBinding(shortcut("quick-add", "cmd+a")),
    },
    {
      id: "search",
      name: "Search Tasks",
      callback: () => setSearchOpen(true),
      hotkey: formatShortcutBinding(shortcut("search", "cmd+k")),
    },
    {
      id: "new-project",
      name: "New Project",
      callback: () => setProjectModalOpen(true),
      hotkey: formatShortcutBinding(shortcut("new-project", "g n")),
    },
    {
      id: "undo",
      name: "Undo Last Action",
      callback: () => void undo(),
      hotkey: formatShortcutBinding(shortcut("undo", "cmd+z")),
    },
    {
      id: "redo",
      name: "Redo Last Action",
      callback: () => void redo(),
      hotkey: formatShortcutBinding(shortcut("redo", "cmd+shift+z")),
    },
    { id: "today", name: "Go to Today", callback: () => handleNavigate("today") },
    { id: "inbox", name: "Go to Inbox", callback: () => handleNavigate("inbox") },
    { id: "upcoming", name: "Go to Upcoming", callback: () => handleNavigate("upcoming") },
    { id: "someday", name: "Go to Someday", callback: () => handleNavigate("someday") },
    { id: "completed", name: "Go to Completed", callback: () => handleNavigate("completed") },
    { id: "cancelled", name: "Go to Cancelled", callback: () => handleNavigate("cancelled") },
    {
      id: "filters",
      name: "Go to Filters & Labels",
      callback: () => handleNavigate("filters-labels"),
    },
    ...(!phase2VisualFixture
      ? [
          { id: "calendar", name: "Go to Calendar", callback: () => handleNavigate("calendar") },
          { id: "matrix", name: "Go to Matrix", callback: () => handleNavigate("matrix") },
          { id: "stats", name: "Go to Stats", callback: () => handleNavigate("stats") },
          {
            id: "dopamine-menu",
            name: "Go to Quick Wins",
            callback: () => handleNavigate("dopamine-menu"),
          },
          {
            id: "timeblocking",
            name: "Go to Timeblocking",
            callback: () => handleNavigate("timeblocking"),
          },
          {
            id: "settings",
            name: "Go to Settings",
            callback: () => handleNavigate({ name: "settings" }),
          },
          {
            id: "settings-data",
            name: "Go to Data",
            callback: () => handleNavigate({ name: "settings", tab: "data" }),
          },
          {
            id: "settings-templates",
            name: "Go to Templates",
            callback: () => handleNavigate({ name: "settings", tab: "templates" }),
          },
          ...(focusModeEnabled
            ? [
                {
                  id: "focus-mode",
                  name: "Enter Focus Mode",
                  callback: () => handleEnterFocusMode(),
                  hotkey: formatShortcutBinding(shortcut("focus-mode", "cmd+shift+f")),
                },
              ]
            : []),
          ...(dailyPlanningEnabled
            ? [
                {
                  id: "plan-my-day",
                  name: "Plan My Day",
                  callback: () => setPlanMyDayOpen(true),
                },
                {
                  id: "end-of-day",
                  name: "End of Day",
                  callback: () => setEndOfDayOpen(true),
                },
              ]
            : []),
          ...(weeklyReviewEnabled
            ? [
                {
                  id: "weekly-review",
                  name: "Weekly Review",
                  callback: () => setWeeklyReviewOpen(true),
                },
              ]
            : []),
        ]
      : []),
  ];

  // Find current project for Project view
  const currentProject =
    route.name === "project"
      ? (catalog?.projects.find((p) => p.id === route.projectId) ?? null)
      : null;

  return (
    <div
      ref={rootRef}
      className={`flex h-screen flex-col bg-surface text-on-surface pb-[--height-bottom-nav] md:pb-0 ${
        phase2VisualFixture ? "" : "md:h-[calc(100vh-25px)]"
      }`}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent-action focus:text-on-accent-action focus:rounded-lg focus:text-sm"
      >
        Skip to main content
      </a>

      {/* SSE error banner */}
      {sseError && (
        <div
          role="alert"
          className="bg-warning/10 border-b border-warning/30 px-4 py-2 text-sm text-on-warning"
        >
          {sseError}{" "}
          <button onClick={() => void refreshCatalog()} className="underline">
            Retry
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <div className="hidden md:flex">
          <ErrorBoundary
            fallback={
              <div className="p-4 text-sm text-on-surface-secondary">Sidebar failed to load.</div>
            }
          >
            <Sidebar
              currentView={view}
              currentRoute={route}
              onNavigate={handleNavigate}
              onAddTask={handleAddTask}
              onSearch={() => setSearchOpen(true)}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
              catalog={catalog}
              onOpenProjectModal={() => setProjectModalOpen(true)}
              phase2VisualFixture={phase2VisualFixture}
              phase3VisualFixture={phase3VisualFixture}
            />
          </ErrorBoundary>
        </div>

        {/* Main content */}
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="flex-1 overflow-auto p-3 md:p-6 flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          <div className="max-w-7xl w-full mx-auto flex-1 flex flex-col">
            <ErrorBoundary
              fallback={
                <div className="p-4 text-sm text-on-surface-secondary">
                  This view failed to load.
                </div>
              }
            >
              <div className="animate-fade-in flex-1 flex flex-col">
                {/* Bulk action bar */}
                {multiSelect.count > 0 && (
                  <BulkActionBar
                    selectedCount={multiSelect.count}
                    onComplete={handleBulkComplete}
                    onDelete={handleBulkDelete}
                    onMoveToProject={handleBulkMove}
                    onAddTag={handleBulkTag}
                    onClear={multiSelect.clear}
                    projects={catalog?.projects ?? []}
                    tags={catalog?.tags ?? []}
                  />
                )}

                {/* View routing */}
                {route.name === "today" && (
                  <Today
                    onToggleTask={handleToggleTask}
                    onSelectTask={handleSelectTask}
                    selectedTaskId={selectedTaskId}
                    selectedTaskIds={multiSelect.selectedIds}
                    onMultiSelect={multiSelect.handleSelect}
                    autoFocusTrigger={addTaskTrigger}
                    onPlanMyDay={
                      phase2VisualFixture || !dailyPlanningEnabled
                        ? undefined
                        : () => setPlanMyDayOpen(true)
                    }
                    onEndOfDay={
                      phase2VisualFixture || !dailyPlanningEnabled
                        ? undefined
                        : () => setEndOfDayOpen(true)
                    }
                    onWeeklyReview={
                      phase2VisualFixture || !weeklyReviewEnabled
                        ? undefined
                        : () => setWeeklyReviewOpen(true)
                    }
                    phase2DetailVisualFixture={phase2DetailVisualFixture}
                  />
                )}
                {route.name === "inbox" && (
                  <Inbox
                    onToggleTask={handleToggleTask}
                    onSelectTask={handleSelectTask}
                    selectedTaskId={selectedTaskId}
                    selectedTaskIds={multiSelect.selectedIds}
                    onMultiSelect={multiSelect.handleSelect}
                    autoFocusTrigger={addTaskTrigger}
                  />
                )}
                {route.name === "upcoming" && (
                  <Upcoming
                    onSelectTask={handleSelectTask}
                    selectedTaskId={selectedTaskId}
                    selectedTaskIds={multiSelect.selectedIds}
                    onMultiSelect={multiSelect.handleSelect}
                    autoFocusTrigger={addTaskTrigger}
                    onToggleTask={handleToggleTask}
                  />
                )}
                {route.name === "someday" && <Someday onSelectTask={handleSelectTask} />}
                {route.name === "completed" && <Completed onSelectTask={handleSelectTask} />}
                {route.name === "cancelled" && <Cancelled onSelectTask={handleSelectTask} />}
                {route.name === "filters-labels" && (
                  <FiltersLabels
                    onSelectTask={handleSelectTask}
                    selectedTaskId={selectedTaskId}
                    selectedTaskIds={multiSelect.selectedIds}
                    onMultiSelect={multiSelect.handleSelect}
                    onNavigate={handleNavigate}
                    onToggleTask={handleToggleTask}
                  />
                )}
                {route.name === "saved-filter" && (
                  <FilterView
                    filterId={route.filterId}
                    onSelectTask={handleSelectTask}
                    selectedTaskId={selectedTaskId}
                    selectedTaskIds={multiSelect.selectedIds}
                    onMultiSelect={multiSelect.handleSelect}
                    onToggleTask={handleToggleTask}
                  />
                )}
                {route.name === "project" && currentProject && route.layout === "calendar" && (
                  <Calendar
                    projectId={currentProject.id}
                    project={currentProject}
                    onSelectTask={handleSelectTask}
                    onToggleTask={handleToggleTask}
                  />
                )}
                {route.name === "project" && currentProject && route.layout !== "calendar" && (
                  <Project
                    project={currentProject}
                    onSelectTask={handleSelectTask}
                    selectedTaskId={selectedTaskId}
                    selectedTaskIds={multiSelect.selectedIds}
                    onMultiSelect={multiSelect.handleSelect}
                    autoFocusTrigger={addTaskTrigger}
                    onToggleTask={handleToggleTask}
                  />
                )}
                {route.name === "project" && !currentProject && !catalogLoading && (
                  <div className="py-12 text-center">
                    <p className="text-sm text-on-surface-muted">Project not found.</p>
                  </div>
                )}
                {route.name === "project" && catalogLoading && <ViewSkeleton />}
                {route.name === "task" && <TaskPage />}
                {route.name === "calendar" && (
                  <Calendar onSelectTask={handleSelectTask} onToggleTask={handleToggleTask} />
                )}
                {route.name === "matrix" && (
                  <Matrix
                    onSelectTask={handleSelectTask}
                    onToggleTask={handleToggleTask}
                    selectedTaskId={selectedTaskId}
                  />
                )}
                {route.name === "stats" && <Stats />}
                {route.name === "dopamine-menu" && (
                  <DopamineMenu
                    onSelectTask={handleSelectTask}
                    onToggleTask={handleToggleTask}
                    selectedTaskId={selectedTaskId}
                    selectedTaskIds={multiSelect.selectedIds}
                    onMultiSelect={multiSelect.handleSelect}
                  />
                )}
                {route.name === "timeblocking" && (
                  <Timeblocking onSelectTask={handleSelectTask} onToggleTask={handleToggleTask} />
                )}
              </div>
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {/* Mobile drawer */}
      {isMobile && (
        <div className="contents" data-app-overlay>
          <MobileDrawer
            id={MOBILE_DRAWER_ID}
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            manageBackground={false}
          >
            <Sidebar
              currentView={view}
              currentRoute={route}
              onNavigate={handleNavigate}
              onAddTask={() => {
                setDrawerOpen(false);
                handleAddTask();
              }}
              onSearch={() => {
                setDrawerOpen(false);
                setSearchOpen(true);
              }}
              collapsed={false}
              onToggleCollapsed={() => {}}
              catalog={catalog}
              onOpenProjectModal={() => {
                setDrawerOpen(false);
                setProjectModalOpen(true);
              }}
              phase2VisualFixture={phase2VisualFixture}
              phase3VisualFixture={phase3VisualFixture}
            />
          </MobileDrawer>
        </div>
      )}

      {/* Mobile nav */}
      {isMobile && (
        <>
          <FAB onClick={handleAddTask} />
          <BottomNavBar
            currentView={view}
            onNavigate={handleNavigate}
            onMenuOpen={() => setDrawerOpen(true)}
            menuOpen={drawerOpen}
            menuId={MOBILE_DRAWER_ID}
          />
        </>
      )}

      {/* Task detail panel — stays mounted across background refreshes so drafts survive. */}
      <div className="contents" data-app-overlay>
        {selectedTaskId &&
          detailTask &&
          detailTask.id === selectedTaskId &&
          (phase2TaskDetailVisualFixture ? (
            <Phase2TaskDetailVisualFixture
              task={detailTask}
              onClose={() => setSelectedTaskId(null)}
            />
          ) : (
            <TaskDetailPanel
              task={detailTask}
              onClose={() => setSelectedTaskId(null)}
              onOpenFullPage={handleOpenFullPage}
              returnFocusTo={taskDetailOpenerRef.current}
              onEnterFocusMode={
                focusModeEnabled ? (taskId) => handleEnterFocusMode(taskId) : undefined
              }
              phase3VisualFixture={phase3VisualFixture}
            />
          ))}
        {selectedTaskId && detailLoading && (!detailTask || detailTask.id !== selectedTaskId) && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            role="status"
            aria-label="Loading task details"
          >
            <p className="rounded-lg bg-surface px-4 py-3 text-sm text-on-surface-secondary">
              Loading task…
            </p>
          </div>
        )}
      </div>

      {/* Modals */}
      <div className="contents" data-app-overlay>
        <QuickAddModal
          open={quickAddOpen}
          onClose={() => setQuickAddOpen(false)}
          onManageTemplates={() => handleNavigate({ name: "settings", tab: "templates" })}
        />
        <SearchModal
          isOpen={searchOpen}
          onClose={() => setSearchOpen(false)}
          onSelectTask={handleSelectTask}
        />
        <CommandPalette
          commands={paletteCommands}
          isOpen={paletteOpen}
          onClose={() => setPaletteOpen(false)}
        />
        <AddProjectModal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} />
        <DailyPlanningModal
          open={planMyDayOpen && dailyPlanningEnabled}
          onClose={() => setPlanMyDayOpen(false)}
        />
        <DailyReviewModal
          open={endOfDayOpen && dailyPlanningEnabled}
          onClose={() => setEndOfDayOpen(false)}
        />
        <WeeklyReviewModal
          open={weeklyReviewOpen && weeklyReviewEnabled}
          onClose={() => setWeeklyReviewOpen(false)}
        />
        <FocusMode
          open={focusModeOpen && focusModeEnabled}
          startTaskId={focusStartTaskId}
          onClose={handleCloseFocusMode}
          onPendingChange={(pending) => {
            focusMutationPendingRef.current = pending;
            setFocusMutationPending(pending);
          }}
        />
        {settingsOpen && (
          <SettingsDialog
            tab={settingsLocation.open ? settingsLocation.tab : null}
            onNavigateTab={navigateSettings}
            onClose={closeSettings}
            returnFocusTarget={settingsOpenerRef.current}
          />
        )}
      </div>

      {/* Toasts stay outside shell isolation so Undo remains usable over detail/modals. */}
      <div className="contents" data-app-overlay>
        <ToastContainer
          toasts={toasts}
          onDismiss={dismissToast}
          onUndo={(opId) => void undo(opId)}
        />
      </div>

      {/* Chord indicator */}
      <ChordIndicator chord={chord} />
    </div>
  );
}
