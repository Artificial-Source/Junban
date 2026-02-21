import { useState, useEffect, useCallback, useRef } from "react";
import type { SettingsTab } from "../views/settings/types.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

export type View =
  | "inbox"
  | "today"
  | "upcoming"
  | "calendar"
  | "project"
  | "task"
  | "plugin-view"
  | "filters-labels"
  | "completed"
  | "ai-chat";

export type CalendarMode = "day" | "week" | "month";

interface RouteState {
  view: View;
  projectId: string | null;
  taskId: string | null;
  pluginViewId: string | null;
  focusModeOpen: boolean;
  calendarMode: CalendarMode | null;
}

const DEFAULT_ROUTE_STATE: RouteState = {
  view: "inbox",
  projectId: null,
  taskId: null,
  pluginViewId: null,
  focusModeOpen: false,
  calendarMode: null,
};

function decodePathSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseRouteStateFromHash(hash: string, defaultView: View = "inbox"): RouteState {
  const hashValue = hash.startsWith("#") ? hash.slice(1) : hash;
  const hasExplicitPath = hashValue.startsWith("/") && hashValue.length > 1;
  const normalized = hasExplicitPath ? hashValue : `/${defaultView}`;
  const [rawPath, rawQuery = ""] = normalized.split("?");
  const pathSegments = rawPath.split("/").filter(Boolean);
  const params = new URLSearchParams(rawQuery);
  const route: RouteState = { ...DEFAULT_ROUTE_STATE };
  const root = pathSegments[0] ?? defaultView;

  switch (root) {
    case "inbox":
      route.view = "inbox";
      break;
    case "today":
      route.view = "today";
      break;
    case "upcoming":
      route.view = "upcoming";
      break;
    case "calendar": {
      route.view = "calendar";
      const modeParam = params.get("mode");
      if (modeParam === "day" || modeParam === "week" || modeParam === "month") {
        route.calendarMode = modeParam;
      }
      break;
    }
    case "project":
      route.view = "project";
      route.projectId = decodePathSegment(pathSegments[1]);
      if (!route.projectId) route.view = "inbox";
      break;
    case "task":
      route.view = "task";
      route.taskId = decodePathSegment(pathSegments[1]);
      if (!route.taskId) route.view = "inbox";
      break;
    case "settings":
      // Settings is now a modal — redirect old settings URLs to inbox
      route.view = "inbox";
      break;
    case "plugin-store":
      // Plugin store is now inside Settings > Plugins — redirect to inbox
      route.view = "inbox";
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
    case "ai-chat":
      route.view = "ai-chat";
      break;
    default:
      route.view = defaultView;
      break;
  }

  route.focusModeOpen = params.get("focus") === "1";
  return route;
}

function buildHashFromRoute(route: RouteState): string {
  const params = new URLSearchParams();

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
    case "task":
      path = route.taskId ? `/task/${encodeURIComponent(route.taskId)}` : "/inbox";
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
    case "calendar":
      path = "/calendar";
      if (route.calendarMode) {
        params.set("mode", route.calendarMode);
      }
      break;
    case "ai-chat":
      path = "/ai-chat";
      break;
    case "inbox":
    default:
      path = "/inbox";
      break;
  }

  const query = params.toString();
  return `#${path}${query ? `?${query}` : ""}`;
}

export function useRouting() {
  const { settings } = useGeneralSettings();
  const startView = settings.start_view as View;
  const [currentView, setCurrentView] = useState<View>(startView);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRouteTaskId, setSelectedRouteTaskId] = useState<string | null>(null);
  const [selectedPluginViewId, setSelectedPluginViewId] = useState<string | null>(null);
  const settingsTabRef = useRef<SettingsTab>("general");
  const [, setSettingsTabTrigger] = useState(0);

  const [focusModeOpen, setFocusModeOpen] = useState(false);
  const [calendarMode, setCalendarMode] = useState<CalendarMode | null>(null);
  const [routeReady, setRouteReady] = useState(false);
  const navigationKeyRef = useRef<string | null>(null);

  const applyRouteState = useCallback((route: RouteState) => {
    setCurrentView(route.view);
    setSelectedProjectId(route.view === "project" ? route.projectId : null);
    setSelectedRouteTaskId(route.view === "task" ? route.taskId : null);
    setSelectedPluginViewId(route.view === "plugin-view" ? route.pluginViewId : null);
    setCalendarMode(route.view === "calendar" ? route.calendarMode : null);
    setFocusModeOpen(route.focusModeOpen);
  }, []);

  // Sync from hash on mount and popstate/hashchange
  useEffect(() => {
    const syncRouteFromLocation = () => {
      const route = parseRouteStateFromHash(window.location.hash, startView);
      applyRouteState(route);
      navigationKeyRef.current = `${route.view}:${route.projectId ?? ""}:${route.taskId ?? ""}:${route.pluginViewId ?? ""}`;
    };

    syncRouteFromLocation();
    setRouteReady(true);

    window.addEventListener("popstate", syncRouteFromLocation);
    window.addEventListener("hashchange", syncRouteFromLocation);
    return () => {
      window.removeEventListener("popstate", syncRouteFromLocation);
      window.removeEventListener("hashchange", syncRouteFromLocation);
    };
  }, [applyRouteState, startView]);

  // Push/replace hash when route state changes
  useEffect(() => {
    if (!routeReady) return;

    const route: RouteState = {
      view: currentView,
      projectId: selectedProjectId,
      taskId: selectedRouteTaskId,
      pluginViewId: selectedPluginViewId,
      focusModeOpen,
      calendarMode,
    };

    const nextHash = buildHashFromRoute(route);
    const navigationKey = `${currentView}:${selectedProjectId ?? ""}:${selectedRouteTaskId ?? ""}:${selectedPluginViewId ?? ""}`;

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
    selectedRouteTaskId,
    selectedPluginViewId,
    focusModeOpen,
    calendarMode,
  ]);

  const handleNavigate = useCallback(
    (view: string, id?: string) => {
      const nextRoute: RouteState = {
        view: view as View,
        projectId: view === "project" ? (id ?? null) : null,
        taskId: view === "task" ? (id ?? null) : null,
        pluginViewId: view === "plugin-view" ? (id ?? null) : null,
        focusModeOpen,
        calendarMode: view === "calendar" ? calendarMode : null,
      };

      applyRouteState(nextRoute);
    },
    [applyRouteState, focusModeOpen, calendarMode],
  );

  const openSettingsTab = useCallback((tab: SettingsTab) => {
    settingsTabRef.current = tab;
    // Trigger re-render only when opening from outside (command palette, etc.)
    setSettingsTabTrigger((n) => n + 1);
  }, []);

  return {
    currentView,
    selectedProjectId,
    selectedRouteTaskId,
    selectedPluginViewId,
    settingsTab: settingsTabRef.current,
    focusModeOpen,
    setFocusModeOpen,
    calendarMode,
    setCalendarMode,
    handleNavigate,
    openSettingsTab,
  };
}
