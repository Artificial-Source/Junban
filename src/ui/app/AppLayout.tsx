/**
 * Phase 2 App Layout: full sidebar, all views, modals, SSE, toasts, bulk actions.
 * Preserves the exact legacy shell: responsive sidebar/header/main/skip-link,
 * mobile drawer and bottom nav, task detail panel, command palette, search,
 * quick add, and project modals.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { NavigateTarget } from "../hooks/useRouting";
import { useRouting } from "../hooks/useRouting";
import { useWorkspace } from "../context/WorkspaceContext";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  useKeyboardShortcuts,
  ChordIndicator,
  type ShortcutCommand,
} from "../hooks/useKeyboardShortcuts";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { Sidebar } from "../components/Sidebar";
import { BottomNavBar } from "../components/BottomNavBar";
import { FAB } from "../components/FAB";
import { MobileDrawer } from "../components/MobileDrawer";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ToastContainer } from "../components/Toast";
import { BulkActionBar } from "../components/BulkActionBar";
import { ViewSkeleton } from "../components/Skeleton";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import { CommandPalette, type Command } from "../components/CommandPalette";
import { SearchModal } from "../components/SearchModal";
import { QuickAddModal } from "../components/QuickAddModal";
import { AddProjectModal } from "../components/AddProjectModal";
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
import type { TaskDto } from "../api/client";
import { getTask } from "../api/client";
import { detailRefreshFromEvent } from "./detailRefresh";
import { isShellBlocking, isTaskDetailLayerActive, isolateShellSiblings } from "./shellIsolation";
import { shouldEnableAppShortcuts } from "./shortcutGate";

const MOBILE_DRAWER_ID = "junban-mobile-nav-drawer";

export function AppLayout() {
  const { route, view, navigate } = useRouting();
  const {
    catalog,
    catalogLoading,
    refreshCatalog,
    toasts,
    dismissToast,
    undo,
    redo,
    sseError,
    registerTaskEventHandler,
  } = useWorkspace();
  const { completeTask, uncompleteTask, bulkTasks } = useTaskMutations();

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
  const [detailTask, setDetailTask] = useState<TaskDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const multiSelect = useMultiSelect();
  const selectedTaskIdRef = useRef<string | null>(null);
  const taskDetailOpenerRef = useRef<HTMLElement | null>(null);
  selectedTaskIdRef.current = selectedTaskId;
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
  });

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

  // Keyboard shortcuts
  const commands: ShortcutCommand[] = [
    {
      id: "quick-add",
      description: "Quick Add",
      defaultKey: "cmd+a",
      action: () => setQuickAddOpen(true),
    },
    { id: "search", description: "Search", defaultKey: "cmd+k", action: () => setSearchOpen(true) },
    {
      id: "command-palette",
      description: "Command Palette",
      defaultKey: "cmd+shift+p",
      action: () => setPaletteOpen(true),
    },
    {
      id: "new-project",
      description: "New Project",
      defaultKey: "cmd+shift+n",
      action: () => setProjectModalOpen(true),
    },
    { id: "undo", description: "Undo", defaultKey: "cmd+z", action: () => void undo() },
    { id: "redo", description: "Redo", defaultKey: "cmd+shift+z", action: () => void redo() },
    {
      id: "today",
      description: "Go to Today",
      chord: "g t",
      defaultKey: "",
      action: () => handleNavigate("today"),
    },
    {
      id: "inbox",
      description: "Go to Inbox",
      chord: "g i",
      defaultKey: "",
      action: () => handleNavigate("inbox"),
    },
    {
      id: "upcoming",
      description: "Go to Upcoming",
      chord: "g u",
      defaultKey: "",
      action: () => handleNavigate("upcoming"),
    },
    {
      id: "someday",
      description: "Go to Someday",
      chord: "g s",
      defaultKey: "",
      action: () => handleNavigate("someday"),
    },
    {
      id: "completed",
      description: "Go to Completed",
      chord: "g c",
      defaultKey: "",
      action: () => handleNavigate("completed"),
    },
    {
      id: "cancelled",
      description: "Go to Cancelled",
      chord: "g x",
      defaultKey: "",
      action: () => handleNavigate("cancelled"),
    },
    {
      id: "filters",
      description: "Go to Filters & Labels",
      chord: "g f",
      defaultKey: "",
      action: () => handleNavigate("filters-labels"),
    },
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
    }),
  );

  // Command palette commands
  const paletteCommands: Command[] = [
    {
      id: "quick-add",
      name: "Quick Add Task",
      callback: () => setQuickAddOpen(true),
      hotkey: "⌘A",
    },
    { id: "search", name: "Search Tasks", callback: () => setSearchOpen(true), hotkey: "⌘K" },
    {
      id: "new-project",
      name: "New Project",
      callback: () => setProjectModalOpen(true),
      hotkey: "⌘⇧N",
    },
    { id: "undo", name: "Undo Last Action", callback: () => void undo(), hotkey: "⌘Z" },
    { id: "redo", name: "Redo Last Action", callback: () => void redo(), hotkey: "⌘⇧Z" },
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
  ];

  // Find current project for Project view
  const currentProject =
    route.name === "project"
      ? (catalog?.projects.find((p) => p.id === route.projectId) ?? null)
      : null;

  return (
    <div
      ref={rootRef}
      className="flex flex-col h-screen bg-surface text-on-surface pb-[--height-bottom-nav] md:pb-0"
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
                {route.name === "project" && currentProject && (
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
        {selectedTaskId && detailTask && detailTask.id === selectedTaskId && (
          <TaskDetailPanel
            task={detailTask}
            onClose={() => setSelectedTaskId(null)}
            onOpenFullPage={handleOpenFullPage}
            returnFocusTo={taskDetailOpenerRef.current}
          />
        )}
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
          onManageTemplates={() => handleNavigate("filters-labels")}
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
