import { useEffect, useRef, useState } from "react";
import type { TaskDto } from "../api/client";
import type { View } from "../hooks/useRouting";
import { Sidebar } from "../components/Sidebar";
import { BottomNavBar } from "../components/BottomNavBar";
import { FAB } from "../components/FAB";
import { MobileDrawer } from "../components/MobileDrawer";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import { Today } from "../views/Today";
import { Inbox } from "../views/Inbox";
import { useToday } from "../hooks/useToday";
import { calendarDayKey } from "../lib/dates";

interface AppLayoutProps {
  view: View;
  navigate: (view: View) => void;
  tasks: TaskDto[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCreateTask: (title: string, dueDate: string | null) => Promise<boolean>;
  onToggleTask: (id: string) => void;
  onUpdateTask: (taskId: string, title: string, dueDate: string | null) => Promise<boolean>;
  onDeleteTask: (taskId: string) => Promise<boolean>;
}

export function AppLayout({
  view,
  navigate,
  tasks,
  loading,
  error,
  onRetry,
  onCreateTask,
  onToggleTask,
  onUpdateTask,
  onDeleteTask,
}: AppLayoutProps) {
  const mainRef = useRef<HTMLElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addTaskTrigger, setAddTaskTrigger] = useState(0);
  const today = useToday();

  // Detect mobile viewport
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Focus main content on view change
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  // Compute inbox and today counts for sidebar/bottom nav badges
  const inboxCount = tasks
    .filter((t) => t.status === "pending" || t.status === "completed")
    .filter((t) => t.status === "pending").length;
  const todayCount = tasks.filter((t) => {
    if (t.status !== "pending" || !t.due_date) return false;
    return calendarDayKey(t.due_date) === today;
  }).length;

  const selectedTask = selectedTaskId ? (tasks.find((t) => t.id === selectedTaskId) ?? null) : null;

  const handleNavigate = (target: View) => {
    navigate(target);
    setDrawerOpen(false);
  };

  const handleAddTask = () => {
    setAddTaskTrigger((prev) => prev + 1);
  };

  return (
    <div className="flex flex-col h-screen bg-surface text-on-surface pb-[--height-bottom-nav] md:pb-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-accent-action focus:text-on-accent-action focus:rounded-lg focus:text-sm"
      >
        Skip to main content
      </a>
      <div className="flex flex-1 overflow-hidden">
        <div className="hidden md:flex">
          <ErrorBoundary
            fallback={
              <div className="p-4 text-sm text-on-surface-secondary">Sidebar failed to load.</div>
            }
          >
            <Sidebar
              currentView={view}
              onNavigate={handleNavigate}
              onAddTask={handleAddTask}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
              inboxCount={inboxCount}
              todayCount={todayCount}
            />
          </ErrorBoundary>
        </div>
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="flex-1 overflow-auto p-3 md:p-6 flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          <div className="max-w-7xl w-full mx-auto flex-1 flex flex-col">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="text-sm text-on-surface-muted">Loading tasks…</div>
              </div>
            ) : error ? (
              <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4">
                <p className="text-sm font-medium text-error">Could not load tasks: {error}</p>
                <p className="mt-1 text-sm text-on-surface-secondary">
                  No task snapshot is available. Retry the read or inspect the diagnostics log.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void onRetry()}
                    className="px-3 py-1.5 text-sm rounded-lg bg-accent-action text-on-accent-action hover:bg-accent-action-hover transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : (
              <ErrorBoundary
                fallback={
                  <div className="p-4 text-sm text-on-surface-secondary">
                    This view failed to load.
                  </div>
                }
              >
                <div className="animate-fade-in flex-1 flex flex-col">
                  {view === "today" ? (
                    <Today
                      tasks={tasks}
                      onCreateTask={onCreateTask}
                      onToggleTask={onToggleTask}
                      onSelectTask={setSelectedTaskId}
                      selectedTaskId={selectedTaskId}
                      autoFocusTrigger={addTaskTrigger}
                    />
                  ) : (
                    <Inbox
                      tasks={tasks}
                      onCreateTask={onCreateTask}
                      onToggleTask={onToggleTask}
                      onSelectTask={setSelectedTaskId}
                      selectedTaskId={selectedTaskId}
                      autoFocusTrigger={addTaskTrigger}
                    />
                  )}
                </div>
              </ErrorBoundary>
            )}
          </div>
        </main>
      </div>

      {isMobile && (
        <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <Sidebar
            currentView={view}
            onNavigate={handleNavigate}
            onAddTask={() => {
              setDrawerOpen(false);
              handleAddTask();
            }}
            collapsed={false}
            onToggleCollapsed={() => {}}
            inboxCount={inboxCount}
            todayCount={todayCount}
          />
        </MobileDrawer>
      )}

      {isMobile && (
        <>
          <FAB onClick={handleAddTask} />
          <BottomNavBar
            currentView={view}
            onNavigate={handleNavigate}
            onMenuOpen={() => setDrawerOpen(true)}
            inboxCount={inboxCount}
            todayCount={todayCount}
          />
        </>
      )}

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          onUpdate={onUpdateTask}
          onDelete={onDeleteTask}
          onToggleComplete={async (taskId) => {
            onToggleTask(taskId);
            return true;
          }}
          onClose={() => setSelectedTaskId(null)}
          todayKey={today}
        />
      )}
    </div>
  );
}
