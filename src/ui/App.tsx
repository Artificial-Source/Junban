import { useState, useEffect, useMemo, useCallback } from "react";
import { Sidebar } from "./components/Sidebar.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { TaskProvider, useTaskContext } from "./context/TaskContext.js";
import { PluginProvider, usePluginContext } from "./context/PluginContext.js";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation.js";
import { themeManager } from "./themes/manager.js";
import { Inbox } from "./views/Inbox.js";
import { Today } from "./views/Today.js";
import { Upcoming } from "./views/Upcoming.js";
import { Project } from "./views/Project.js";
import { Settings } from "./views/Settings.js";
import { PluginStore } from "./views/PluginStore.js";
import { PluginView } from "./views/PluginView.js";
import type { Project as ProjectType } from "../core/types.js";
import { api } from "./api.js";

type View = "inbox" | "today" | "upcoming" | "project" | "settings" | "plugin-store" | "plugin-view";

function AppContent() {
  const [currentView, setCurrentView] = useState<View>("inbox");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedPluginViewId, setSelectedPluginViewId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectType[]>([]);
  const { state, createTask, updateTask, completeTask, deleteTask } = useTaskContext();
  const { commands: pluginCommands, panels, views: pluginViews, executeCommand } = usePluginContext();

  // Fetch projects on mount and after task changes
  const fetchProjects = useCallback(async () => {
    try {
      const p = await api.listProjects();
      setProjects(p);
    } catch {
      // Non-critical — projects sidebar just won't populate
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Re-fetch projects when tasks change (new project might have been created)
  useEffect(() => {
    fetchProjects();
  }, [state.tasks, fetchProjects]);

  const handleNavigate = (view: string, id?: string) => {
    if (view === "plugin-view") {
      setCurrentView("plugin-view");
      setSelectedPluginViewId(id ?? null);
    } else {
      setCurrentView(view as View);
      setSelectedProjectId(view === "project" ? (id ?? null) : null);
      setSelectedPluginViewId(null);
    }
    setSelectedTaskId(null);
  };

  const handleCreateTask = async (parsed: {
    title: string;
    priority: number | null;
    tags: string[];
    project: string | null;
    dueDate: Date | null;
    dueTime: boolean;
  }) => {
    await createTask({
      title: parsed.title,
      priority: parsed.priority,
      dueDate: parsed.dueDate?.toISOString() ?? null,
      dueTime: parsed.dueTime,
      tags: parsed.tags,
      projectId: selectedProjectId,
    });
  };

  const handleToggleTask = async (id: string) => {
    await completeTask(id);
  };

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
  };

  const handleCloseDetail = () => {
    setSelectedTaskId(null);
  };

  const handleUpdateTask = async (id: string, input: Parameters<typeof updateTask>[1]) => {
    await updateTask(id, input);
  };

  const handleDeleteTask = async (id: string) => {
    await deleteTask(id);
    setSelectedTaskId(null);
  };

  // Compute visible tasks for keyboard navigation based on current view
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

  // Keyboard navigation
  useKeyboardNavigation({
    tasks: visibleTasks,
    selectedTaskId,
    onSelect: handleSelectTask,
    onOpen: handleSelectTask,
    onClose: handleCloseDetail,
    enabled: !commandPaletteOpen,
  });

  // Ctrl+K / Cmd+K for command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Command palette commands — merge built-in + plugin commands
  const commands = useMemo(() => {
    const cmds = [
      { id: "nav-inbox", name: "Go to Inbox", callback: () => handleNavigate("inbox") },
      { id: "nav-today", name: "Go to Today", callback: () => handleNavigate("today") },
      { id: "nav-upcoming", name: "Go to Upcoming", callback: () => handleNavigate("upcoming") },
      { id: "nav-settings", name: "Go to Settings", callback: () => handleNavigate("settings") },
      { id: "nav-plugin-store", name: "Go to Plugin Store", callback: () => handleNavigate("plugin-store") },
      { id: "theme-toggle", name: "Toggle Dark Mode", callback: () => themeManager.toggle() },
      { id: "theme-light", name: "Switch to Light Theme", callback: () => themeManager.setTheme("light") },
      { id: "theme-dark", name: "Switch to Dark Theme", callback: () => themeManager.setTheme("dark") },
    ];

    for (const project of projects) {
      cmds.push({
        id: `nav-project-${project.id}`,
        name: `Go to Project: ${project.name}`,
        callback: () => handleNavigate("project", project.id),
      });
    }

    // Add plugin commands
    for (const cmd of pluginCommands) {
      cmds.push({
        id: `plugin-${cmd.id}`,
        name: cmd.name,
        callback: () => executeCommand(cmd.id),
      });
    }

    return cmds;
  }, [projects, pluginCommands, executeCommand]);

  const selectedTask = selectedTaskId ? state.tasks.find((t) => t.id === selectedTaskId) : null;

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
          />
        );
      case "today":
        return (
          <Today
            tasks={state.tasks}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            selectedTaskId={selectedTaskId}
          />
        );
      case "upcoming":
        return (
          <Upcoming
            tasks={state.tasks}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            selectedTaskId={selectedTaskId}
          />
        );
      case "project": {
        const project = projects.find((p) => p.id === selectedProjectId);
        if (!project) {
          return <p className="text-gray-500">Project not found.</p>;
        }
        return (
          <Project
            project={project}
            tasks={state.tasks}
            onCreateTask={handleCreateTask}
            onToggleTask={handleToggleTask}
            onSelectTask={handleSelectTask}
            selectedTaskId={selectedTaskId}
          />
        );
      }
      case "settings":
        return <Settings />;
      case "plugin-store":
        return <PluginStore />;
      case "plugin-view":
        return selectedPluginViewId ? (
          <PluginView viewId={selectedPluginViewId} />
        ) : (
          <p className="text-gray-500">No plugin view selected.</p>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          currentView={currentView}
          onNavigate={handleNavigate}
          projects={projects}
          selectedProjectId={selectedProjectId}
          panels={panels}
          pluginViews={pluginViews}
          selectedPluginViewId={selectedPluginViewId}
        />
        <main className="flex-1 overflow-auto p-6">
          {state.loading ? (
            <p className="text-gray-500">Loading...</p>
          ) : state.error ? (
            <p className="text-red-500">Error: {state.error}</p>
          ) : (
            renderView()
          )}
        </main>
        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            onUpdate={handleUpdateTask}
            onDelete={handleDeleteTask}
            onClose={handleCloseDetail}
          />
        )}
      </div>
      <StatusBar />
      <CommandPalette
        commands={commands}
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </div>
  );
}

export function App() {
  return (
    <TaskProvider>
      <PluginProvider>
        <AppContent />
      </PluginProvider>
    </TaskProvider>
  );
}
