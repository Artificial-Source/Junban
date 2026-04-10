import { useState, useEffect, useCallback, useRef } from "react";
import type { SettingsTab } from "../views/settings/types.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { LEGACY_BUILTIN_VIEW_IDS } from "../../plugins/builtin/registry.js";
import { beginNamedPerfSpan } from "../../utils/perf.js";

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
  | "cancelled"
  | "someday"
  | "stats"
  | "matrix"
  | "filter"
  | "ai-chat"
  | "dopamine-menu";

interface RouteState {
  view: View;
  projectId: string | null;
  taskId: string | null;
  pluginViewId: string | null;
  filterId: string | null;
  focusModeOpen: boolean;
}

const DEFAULT_ROUTE_STATE: RouteState = {
  view: "inbox",
  projectId: null,
  taskId: null,
  pluginViewId: null,
  filterId: null,
  focusModeOpen: false,
};

function toLegacyPluginRoute(view: string): RouteState | null {
  const pluginViewId = LEGACY_BUILTIN_VIEW_IDS[view];
  if (!pluginViewId) {
    return null;
  }

  return {
    ...DEFAULT_ROUTE_STATE,
    view: "plugin-view",
    pluginViewId,
  };
}

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
      const legacyRoute = toLegacyPluginRoute(root);
      if (legacyRoute) {
        route.view = legacyRoute.view;
        route.pluginViewId = legacyRoute.pluginViewId;
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
    case "filters":
    case "filters-labels":
      route.view = "filters-labels";
      break;
    case "completed":
    case "cancelled":
    case "someday":
    case "stats":
    case "matrix":
    case "dopamine-menu": {
      const legacyRoute = toLegacyPluginRoute(root);
      if (legacyRoute) {
        route.view = legacyRoute.view;
        route.pluginViewId = legacyRoute.pluginViewId;
      }
      break;
    }
    case "filter":
      route.view = "filter";
      route.filterId = decodePathSegment(pathSegments[1]);
      if (!route.filterId) route.view = "inbox";
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
    case "cancelled":
    case "someday":
    case "stats":
    case "matrix":
    case "dopamine-menu": {
      const pluginViewId = LEGACY_BUILTIN_VIEW_IDS[route.view];
      path = pluginViewId ? `/plugin-view/${encodeURIComponent(pluginViewId)}` : "/inbox";
      break;
    }
    case "filter":
      path = route.filterId ? `/filter/${encodeURIComponent(route.filterId)}` : "/inbox";
      break;
    case "calendar":
      path = `/plugin-view/${encodeURIComponent(LEGACY_BUILTIN_VIEW_IDS.calendar)}`;
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
  const [selectedFilterId, setSelectedFilterId] = useState<string | null>(null);
  const settingsTabRef = useRef<SettingsTab>("general");
  const [, setSettingsTabTrigger] = useState(0);

  const [focusModeOpen, setFocusModeOpen] = useState(false);
  const [routeReady, setRouteReady] = useState(false);
  const navigationKeyRef = useRef<string | null>(null);

  const applyRouteState = useCallback((route: RouteState) => {
    setCurrentView(route.view);
    setSelectedProjectId(route.view === "project" ? route.projectId : null);
    setSelectedRouteTaskId(route.view === "task" ? route.taskId : null);
    setSelectedPluginViewId(route.view === "plugin-view" ? route.pluginViewId : null);
    setSelectedFilterId(route.view === "filter" ? route.filterId : null);
    setFocusModeOpen(route.focusModeOpen);
  }, []);

  // Sync from hash on mount and popstate/hashchange
  useEffect(() => {
    const syncRouteFromLocation = () => {
      const route = parseRouteStateFromHash(window.location.hash, startView);
      applyRouteState(route);
      navigationKeyRef.current = `${route.view}:${route.projectId ?? ""}:${route.taskId ?? ""}:${route.pluginViewId ?? ""}:${route.filterId ?? ""}`;
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
      filterId: selectedFilterId,
      focusModeOpen,
    };

    const nextHash = buildHashFromRoute(route);
    const navigationKey = `${currentView}:${selectedProjectId ?? ""}:${selectedRouteTaskId ?? ""}:${selectedPluginViewId ?? ""}:${selectedFilterId ?? ""}`;

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
    selectedFilterId,
    focusModeOpen,
  ]);

  const handleNavigate = useCallback(
    (view: string, id?: string) => {
      beginNamedPerfSpan("junban:route-change");
      const legacyRoute = toLegacyPluginRoute(view);
      const nextRoute: RouteState = {
        view: legacyRoute?.view ?? (view as View),
        projectId: view === "project" ? (id ?? null) : null,
        taskId: view === "task" ? (id ?? null) : null,
        pluginViewId: view === "plugin-view" ? (id ?? null) : (legacyRoute?.pluginViewId ?? null),
        filterId: view === "filter" ? (id ?? null) : null,
        focusModeOpen,
      };

      applyRouteState(nextRoute);
    },
    [applyRouteState, focusModeOpen],
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
    selectedFilterId,
    settingsTab: settingsTabRef.current,
    focusModeOpen,
    setFocusModeOpen,
    handleNavigate,
    openSettingsTab,
  };
}
