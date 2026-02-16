import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Sidebar } from "./components/Sidebar.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskDetailPanel } from "./components/TaskDetailPanel.js";
import { BulkActionBar } from "./components/BulkActionBar.js";
import { TaskProvider, useTaskContext } from "./context/TaskContext.js";
import { PluginProvider, usePluginContext } from "./context/PluginContext.js";
import { AIProvider } from "./context/AIContext.js";
import { UndoProvider, useUndoContext } from "./context/UndoContext.js";
import { AIChatPanel } from "./components/AIChatPanel.js";
import { FocusMode } from "./components/FocusMode.js";
import { TemplateSelector } from "./components/TemplateSelector.js";
import { Toast } from "./components/Toast.js";
import { Focus } from "lucide-react";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation.js";
import { useMultiSelect } from "./hooks/useMultiSelect.js";
import { ShortcutManager } from "./shortcuts.js";
import { themeManager } from "./themes/manager.js";
import { Inbox } from "./views/Inbox.js";
import { Today } from "./views/Today.js";
import { Upcoming } from "./views/Upcoming.js";
import { Project } from "./views/Project.js";
import { Settings } from "./views/Settings.js";
import { PluginStore } from "./views/PluginStore.js";
import { PluginView } from "./views/PluginView.js";
import { Completed } from "./views/Completed.js";
import { FiltersLabels } from "./views/FiltersLabels.js";
import type { SettingsTab } from "./views/Settings.js";
import type { Project as ProjectType } from "../core/types.js";
import { api } from "./api.js";

const shortcutManager = new ShortcutManager();
const AI_SIDEBAR_OPEN_SETTING_KEY = "ui_ai_sidebar_open";

type View =
  | "inbox"
  | "today"
  | "upcoming"
  | "project"
  | "settings"
  | "plugin-store"
  | "plugin-view"
  | "filters-labels"
  | "completed";

interface RouteState {
  view: View;
  projectId: string | null;
  pluginViewId: string | null;
  inboxQuery: string;
  settingsTab: SettingsTab;
  pluginSearch: string;
  focusModeOpen: boolean;
}

const DEFAULT_ROUTE_STATE: RouteState = {
  view: "inbox",
  projectId: null,
  pluginViewId: null,
  inboxQuery: "",
  settingsTab: "general",
  pluginSearch: "",
  focusModeOpen: false,
};

const SIDEBAR_COLLAPSED_STORAGE_KEY = "docket.ui.sidebar.collapsed";
const AI_CHAT_EXPANDED_STORAGE_KEY = "docket.ui.ai-chat.expanded";

function decodePathSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseSettingsTab(tab: string | null): SettingsTab {
  const validTabs: SettingsTab[] = [
    "general",
    "ai",
    "plugins",
    "templates",
    "keyboard",
    "data",
    "about",
  ];
  if (tab && validTabs.includes(tab as SettingsTab)) {
    return tab as SettingsTab;
  }
  return "general";
}

function parseRouteStateFromHash(hash: string): RouteState {
  const hashValue = hash.startsWith("#") ? hash.slice(1) : hash;
  const normalized = hashValue.startsWith("/") ? hashValue : "/inbox";
  const [rawPath, rawQuery = ""] = normalized.split("?");
  const pathSegments = rawPath.split("/").filter(Boolean);
  const params = new URLSearchParams(rawQuery);
  const route: RouteState = { ...DEFAULT_ROUTE_STATE };
  const root = pathSegments[0] ?? "inbox";

  switch (root) {
    case "inbox":
      route.view = "inbox";
      route.inboxQuery = params.get("q") ?? "";
      break;
    case "today":
      route.view = "today";
      break;
    case "upcoming":
      route.view = "upcoming";
      break;
    case "project":
      route.view = "project";
      route.projectId = decodePathSegment(pathSegments[1]);
      if (!route.projectId) route.view = "inbox";
      break;
    case "settings":
      route.view = "settings";
      route.settingsTab = parseSettingsTab(params.get("tab"));
      break;
    case "plugin-store":
      route.view = "plugin-store";
      route.pluginSearch = params.get("q") ?? "";
      break;
    case "plugin-view":
      route.view = "plugin-view";
      route.pluginViewId = decodePathSegment(pathSegments[1]);
      if (!route.pluginViewId) route.view = "inbox";
      break;
    case "filters-labels":
      route.view = "filters-labels";
      break;
    case "completed":
      route.view = "completed";
      break;
    default:
      route.view = "inbox";
      break;
  }

  route.focusModeOpen = params.get("focus") === "1";
  return route;
}

function buildHashFromRoute(route: RouteState): string {
  const params = new URLSearchParams();

  if (route.view === "inbox" && route.inboxQuery.trim()) {
    params.set("q", route.inboxQuery);
  }
  if (route.view === "settings") {
    params.set("tab", route.settingsTab);
  }
  if (route.view === "plugin-store" && route.pluginSearch.trim()) {
    params.set("q", route.pluginSearch);
  }
  if (route.focusModeOpen) {
    params.set("focus", "1");
  }
  let path = "/inbox";
  switch (route.view) {
    case "today":
      path = "/today";
      break;
    case "upcoming":
      path = "/upcoming";
      break;
    case "project":
      path = route.projectId ? `/project/${encodeURIComponent(route.projectId)}` : "/inbox";
      break;
    case "settings":
      path = "/settings";
      break;
    case "plugin-store":
      path = "/plugin-store";
      break;
    case "plugin-view":
      path = route.pluginViewId
        ? `/plugin-view/${encodeURIComponent(route.pluginViewId)}`
        : "/inbox";
      break;
    case "filters-labels":
      path = "/filters-labels";
      break;
    case "completed":
      path = "/completed";
      break;
    case "inbox":
    default:
      path = "/inbox";
      break;
  }

  const query = params.toString();
  return `#${path}${query ? `?${query}` : ""}`;
}

interface RightActionRailProps {
  chatOpen: boolean;
  onToggleChat: () => void;
  onFocusMode: () => void;
}

function RailTooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-on-surface opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {label}
    </span>
  );
}

function RobotIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3h6" />
      <path d="M12 3v2" />
      <rect x="4" y="7" width="16" height="11" rx="3" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <path d="M9 16h6" />
      <path d="M2 11v3" />
      <path d="M22 11v3" />
    </svg>
  );
}

function RightActionRail({ chatOpen, onToggleChat, onFocusMode }: RightActionRailProps) {
  return (
    <aside
      aria-label="Quick tools"
      className="w-14 border-l border-border bg-surface-secondary flex flex-col items-center justify-start gap-3 pt-4"
    >
      <button
        onClick={onToggleChat}
        aria-label={chatOpen ? "Close AI chat" : "Open AI chat"}
        aria-pressed={chatOpen}
        className={`group relative w-11 h-11 rounded-lg border flex items-center justify-center transition-colors ${
          chatOpen
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-transparent text-on-surface-secondary hover:text-on-surface hover:bg-surface-tertiary"
        }`}
      >
        <RobotIcon className="w-5 h-5" />
        <RailTooltip label="AI Chat" />
      </button>

      <button
        onClick={onFocusMode}
        aria-label="Enter focus mode"
        className="group relative w-11 h-11 rounded-lg border border-transparent flex items-center justify-center text-on-surface-secondary hover:text-on-surface hover:bg-surface-tertiary transition-colors"
      >
        <Focus size={19} />
        <RailTooltip label="Focus Mode" />
      </button>
    </aside>
  );
}

function AppContent() {
  const [currentView, setCurrentView] = useState<View>("inbox");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedPluginViewId, setSelectedPluginViewId] = useState<string | null>(null);
  const [inboxQueryText, setInboxQueryText] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [pluginStoreSearchQuery, setPluginStoreSearchQuery] = useState("");
  const [routeReady, setRouteReady] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AI_CHAT_EXPANDED_STORAGE_KEY) === "1";
  });
  const [chatPanelStateLoaded, setChatPanelStateLoaded] = useState(false);
  const [focusModeOpen, setFocusModeOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  });
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectType[]>([]);
  const [addTaskTrigger, setAddTaskTrigger] = useState(0);
  const {
    state,
    createTask,
    updateTask,
    completeTask,
    deleteTask,
    completeManyTasks,
    deleteManyTasks,
    updateManyTasks,
    refreshTasks,
  } = useTaskContext();
  const { undo, redo, toast, dismissToast } = useUndoContext();
  const {
    commands: pluginCommands,
    panels,
    views: pluginViews,
    executeCommand,
  } = usePluginContext();
  const navigationKeyRef = useRef<string | null>(null);

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

  // Restore AI chat sidebar open/closed state on startup.
  useEffect(() => {
    let mounted = true;
    api
      .getAppSetting(AI_SIDEBAR_OPEN_SETTING_KEY)
      .then((value) => {
        if (!mounted || value === null) {
          return;
        }
        setChatPanelOpen(value === "1" || value.toLowerCase() === "true");
      })
      .catch(() => {
        // Non-critical
      })
      .finally(() => {
        if (mounted) {
          setChatPanelStateLoaded(true);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Persist AI chat sidebar state after initial restore.
  useEffect(() => {
    if (!chatPanelStateLoaded) {
      return;
    }

    api.setAppSetting(AI_SIDEBAR_OPEN_SETTING_KEY, chatPanelOpen ? "1" : "0").catch(() => {
      // Non-critical
    });
  }, [chatPanelOpen, chatPanelStateLoaded]);

  // Re-fetch projects when tasks are added/removed (new project might have been created)
  const taskCount = state.tasks.length;
  useEffect(() => {
    fetchProjects();
  }, [taskCount, fetchProjects]);

  const applyRouteState = useCallback((route: RouteState) => {
    setCurrentView(route.view);
    setSelectedProjectId(route.view === "project" ? route.projectId : null);
    setSelectedPluginViewId(route.view === "plugin-view" ? route.pluginViewId : null);
    setInboxQueryText(route.inboxQuery);
    setSettingsTab(route.settingsTab);
    setPluginStoreSearchQuery(route.pluginSearch);
    setFocusModeOpen(route.focusModeOpen);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(AI_CHAT_EXPANDED_STORAGE_KEY, chatPanelOpen ? "1" : "0");
  }, [chatPanelOpen]);

  useEffect(() => {
    const syncRouteFromLocation = () => {
      const route = parseRouteStateFromHash(window.location.hash);
      applyRouteState(route);
      setSelectedTaskId(null);
      navigationKeyRef.current = `${route.view}:${route.projectId ?? ""}:${route.pluginViewId ?? ""}`;
    };

    syncRouteFromLocation();
    setRouteReady(true);

    window.addEventListener("popstate", syncRouteFromLocation);
    window.addEventListener("hashchange", syncRouteFromLocation);
    return () => {
      window.removeEventListener("popstate", syncRouteFromLocation);
      window.removeEventListener("hashchange", syncRouteFromLocation);
    };
  }, [applyRouteState]);

  useEffect(() => {
    if (!routeReady) return;

    const route: RouteState = {
      view: currentView,
      projectId: selectedProjectId,
      pluginViewId: selectedPluginViewId,
      inboxQuery: inboxQueryText,
      settingsTab,
      pluginSearch: pluginStoreSearchQuery,
      focusModeOpen,
    };

    const nextHash = buildHashFromRoute(route);
    const navigationKey = `${currentView}:${selectedProjectId ?? ""}:${selectedPluginViewId ?? ""}`;

    if (window.location.hash === nextHash) {
      navigationKeyRef.current = navigationKey;
      return;
    }

    if (navigationKeyRef.current === navigationKey) {
      window.history.replaceState(null, "", nextHash);
    } else {
      window.history.pushState(null, "", nextHash);
    }
    navigationKeyRef.current = navigationKey;
  }, [
    routeReady,
    currentView,
    selectedProjectId,
    selectedPluginViewId,
    inboxQueryText,
    settingsTab,
    pluginStoreSearchQuery,
    focusModeOpen,
  ]);

  const handleNavigate = useCallback(
    (view: string, id?: string) => {
      const nextRoute: RouteState = {
        view: view as View,
        projectId: view === "project" ? (id ?? null) : null,
        pluginViewId: view === "plugin-view" ? (id ?? null) : null,
        inboxQuery: inboxQueryText,
        settingsTab,
        pluginSearch: pluginStoreSearchQuery,
        focusModeOpen,
      };

      applyRouteState(nextRoute);
      setSelectedTaskId(null);
    },
    [applyRouteState, inboxQueryText, settingsTab, pluginStoreSearchQuery, focusModeOpen],
  );

  const openSettingsTab = useCallback(
    (tab: SettingsTab) => {
      handleNavigate("settings");
      setSettingsTab(tab);
    },
    [handleNavigate],
  );

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

  // Sidebar badge counts
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

  // Add task handler for sidebar button
  const handleAddTask = useCallback(() => {
    const taskViews: View[] = ["inbox", "today", "upcoming", "project"];
    if (!taskViews.includes(currentView)) {
      handleNavigate("inbox");
    }
    setAddTaskTrigger((n) => n + 1);
  }, [currentView, handleNavigate]);

  // Multi-select
  const {
    selectedIds: multiSelectedIds,
    handleMultiSelect,
    clearSelection,
  } = useMultiSelect(visibleTasks.map((t) => t.id));

  const handleBulkComplete = async () => {
    const ids = Array.from(multiSelectedIds);
    await completeManyTasks(ids);
    clearSelection();
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(multiSelectedIds);
    await deleteManyTasks(ids);
    clearSelection();
  };

  const handleBulkMoveToProject = async (projectId: string | null) => {
    const ids = Array.from(multiSelectedIds);
    await updateManyTasks(ids, { projectId });
    clearSelection();
  };

  const handleBulkAddTag = async (tag: string) => {
    // We need to add a tag to existing tasks. Since updateMany replaces tags,
    // we gather existing tags and append the new one
    const ids = Array.from(multiSelectedIds);
    for (const id of ids) {
      const task = state.tasks.find((t) => t.id === id);
      if (task) {
        const existingTags = task.tags.map((t) => t.name);
        if (!existingTags.includes(tag)) {
          await updateTask(id, { tags: [...existingTags, tag] });
        }
      }
    }
    clearSelection();
  };

  // Sub-task indent/outdent
  const handleIndent = useCallback(async (id: string) => {
    try {
      await api.indentTask(id);
      // TaskContext will refresh on next fetch
    } catch {
      // Non-critical
    }
  }, []);

  const handleOutdent = useCallback(async (id: string) => {
    try {
      await api.outdentTask(id);
    } catch {
      // Non-critical
    }
  }, []);

  // Drag-and-drop reorder
  const handleReorder = useCallback(async (orderedIds: string[]) => {
    try {
      await api.reorderTasks(orderedIds);
      // Refresh tasks to pick up new sort orders
      // The TaskContext will handle this via the next fetch
    } catch {
      // Non-critical — visual order already reflects the change
    }
  }, []);

  // Keyboard navigation
  useKeyboardNavigation({
    tasks: visibleTasks,
    selectedTaskId,
    onSelect: handleSelectTask,
    onOpen: handleSelectTask,
    onClose: handleCloseDetail,
    enabled: !commandPaletteOpen,
  });

  // Load custom themes on mount
  useEffect(() => {
    themeManager.loadCustomThemes();
  }, []);

  // Register shortcuts
  useEffect(() => {
    shortcutManager.register({
      id: "command-palette",
      description: "Open Command Palette",
      defaultKey: "ctrl+k",
      callback: () => setCommandPaletteOpen((open) => !open),
    });
    shortcutManager.register({
      id: "toggle-dark-mode",
      description: "Toggle Dark Mode",
      defaultKey: "ctrl+shift+d",
      callback: () => themeManager.toggle(),
    });
    shortcutManager.register({
      id: "undo",
      description: "Undo",
      defaultKey: "ctrl+z",
      callback: () => undo(),
    });
    shortcutManager.register({
      id: "redo",
      description: "Redo",
      defaultKey: "ctrl+shift+z",
      callback: () => redo(),
    });

    // Load custom bindings from settings
    api.getAppSetting("keyboard_shortcuts").then((val) => {
      if (val) {
        try {
          shortcutManager.loadCustomBindings(JSON.parse(val));
        } catch {
          // Non-critical
        }
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      shortcutManager.handleKeyDown(e);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  // Command palette commands — merge built-in + plugin commands
  const commands = useMemo(() => {
    const cmds = [
      { id: "nav-inbox", name: "Go to Inbox", callback: () => handleNavigate("inbox") },
      { id: "nav-today", name: "Go to Today", callback: () => handleNavigate("today") },
      { id: "nav-upcoming", name: "Go to Upcoming", callback: () => handleNavigate("upcoming") },
      {
        id: "nav-filters-labels",
        name: "Go to Filters & Labels",
        callback: () => handleNavigate("filters-labels"),
      },
      {
        id: "nav-completed",
        name: "Go to Completed",
        callback: () => handleNavigate("completed"),
      },
      { id: "nav-settings", name: "Go to Settings", callback: () => handleNavigate("settings") },
      {
        id: "nav-settings-general",
        name: "Go to Settings: General",
        callback: () => openSettingsTab("general"),
      },
      {
        id: "nav-settings-ai",
        name: "Go to Settings: AI Assistant",
        callback: () => openSettingsTab("ai"),
      },
      {
        id: "nav-settings-plugins",
        name: "Go to Settings: Plugins",
        callback: () => openSettingsTab("plugins"),
      },
      {
        id: "nav-settings-templates",
        name: "Go to Settings: Templates",
        callback: () => openSettingsTab("templates"),
      },
      {
        id: "nav-settings-keyboard",
        name: "Go to Settings: Keyboard",
        callback: () => openSettingsTab("keyboard"),
      },
      {
        id: "nav-settings-data",
        name: "Go to Settings: Data",
        callback: () => openSettingsTab("data"),
      },
      {
        id: "nav-settings-about",
        name: "Go to Settings: About",
        callback: () => openSettingsTab("about"),
      },
      {
        id: "nav-plugin-store",
        name: "Go to Plugin Store",
        callback: () => handleNavigate("plugin-store"),
      },
      { id: "theme-toggle", name: "Toggle Dark Mode", callback: () => themeManager.toggle() },
      {
        id: "theme-light",
        name: "Switch to Light Theme",
        callback: () => themeManager.setTheme("light"),
      },
      {
        id: "theme-dark",
        name: "Switch to Dark Theme",
        callback: () => themeManager.setTheme("dark"),
      },
      { id: "ai-chat-toggle", name: "Toggle AI Chat", callback: () => setChatPanelOpen((o) => !o) },
      { id: "focus-mode", name: "Enter Focus Mode", callback: () => setFocusModeOpen(true) },
      {
        id: "create-from-template",
        name: "Create Task from Template",
        callback: () => setTemplateSelectorOpen(true),
      },
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
  }, [projects, pluginCommands, executeCommand, handleNavigate, openSettingsTab]);

  const selectedTask = selectedTaskId ? state.tasks.find((t) => t.id === selectedTaskId) : null;

  const appTitle = useMemo(() => {
    if (focusModeOpen) {
      return "Focus Mode - Docket";
    }

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
      case "filters-labels":
        return "Filters & Labels - Docket";
      case "completed":
        return "Completed - Docket";
      default:
        return "Docket";
    }
  }, [
    focusModeOpen,
    currentView,
    projects,
    selectedProjectId,
    settingsTab,
    pluginViews,
    selectedPluginViewId,
  ]);

  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

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
            autoFocusTrigger={addTaskTrigger}
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
        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            allTasks={state.tasks}
            onUpdate={handleUpdateTask}
            onDelete={handleDeleteTask}
            onClose={handleCloseDetail}
            onIndent={handleIndent}
            onOutdent={handleOutdent}
            onSelect={handleSelectTask}
          />
        )}
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
