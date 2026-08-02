/**
 * Real-path routing using the History API.
 * The URL fragment remains reserved for access-token bootstrap.
 *
 * Settings is a route-backed overlay: the prior non-settings route stays
 * rendered underneath while the pathname is `/settings` or `/settings/<tab>`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Closed Phase 4 Settings tab identifiers (URL segments). */
export type SettingsTabId =
  | "essentials"
  | "appearance"
  | "features"
  | "keyboard"
  | "templates"
  | "data"
  | "hosted"
  | "diagnostics";

export const SETTINGS_TAB_IDS: readonly SettingsTabId[] = [
  "essentials",
  "appearance",
  "features",
  "keyboard",
  "templates",
  "data",
  "hosted",
  "diagnostics",
] as const;

/** Simple view names used by chrome and Phase 3 destinations. */
export type View =
  | "today"
  | "inbox"
  | "upcoming"
  | "someday"
  | "completed"
  | "cancelled"
  | "search"
  | "filters-labels"
  | "saved-filter"
  | "project"
  | "task"
  | "calendar"
  | "matrix"
  | "stats"
  | "dopamine-menu"
  | "timeblocking";

/** Structured application route (never the Settings overlay itself). */
export type AppRoute =
  | { name: "today" }
  | { name: "inbox" }
  | { name: "upcoming" }
  | { name: "someday" }
  | { name: "completed" }
  | { name: "cancelled" }
  | { name: "search" }
  | { name: "filters-labels" }
  | { name: "saved-filter"; filterId: string }
  | { name: "project"; projectId: string; layout: "list" | "board" | "calendar" }
  | { name: "task"; taskId: string }
  | { name: "calendar" }
  | { name: "matrix" }
  | { name: "stats" }
  | { name: "dopamine-menu" }
  | { name: "timeblocking" };

/** Settings overlay location derived from the URL. */
export type SettingsLocation =
  | { open: false }
  | {
      open: true;
      /** null = mobile category index / desktop Essentials default via `/settings`. */
      tab: SettingsTabId | null;
    };

export type NavigateTarget = View | AppRoute | { name: "settings"; tab?: SettingsTabId | null };

type HistoryState = {
  junbanBackground?: string;
} | null;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isSettingsTabId(value: string): value is SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

/** Read the legacy-compatible Focus Mode query flag. */
export function readFocusQuery(search: string = window.location.search): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  return params.get("focus") === "1";
}

/** Build a path that preserves the current route and sets/clears `?focus=1`. */
export function pathWithFocus(focus: boolean, path?: string, search?: string): string {
  const basePath = path ?? window.location.pathname;
  const params = new URLSearchParams(
    (search ?? window.location.search).startsWith("?")
      ? (search ?? window.location.search)
      : `?${search ?? ""}`,
  );
  if (focus) params.set("focus", "1");
  else params.delete("focus");
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function normalizePath(path: string): string {
  if (!path) return "/";
  const trimmed = path.split("?")[0]?.split("#")[0] ?? "/";
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed || "/";
}

function todayRoute(): AppRoute {
  return { name: "today" };
}

/** Parse a Settings pathname. Returns null when the path is not a settings URL. */
export function parseSettingsLocation(path: string): SettingsLocation | null {
  const normalized = normalizePath(path);
  if (normalized === "/settings") {
    return { open: true, tab: null };
  }
  if (!normalized.startsWith("/settings/")) return null;
  const rest = normalized.slice("/settings/".length);
  if (!rest || rest.includes("/")) return null;
  if (!isSettingsTabId(rest)) return null;
  return { open: true, tab: rest };
}

/** Canonical Settings pathname for a tab (null tab → `/settings`). */
export function settingsToPath(tab: SettingsTabId | null = null): string {
  return tab ? `/settings/${tab}` : "/settings";
}

/**
 * Parse a pathname into a content route.
 * Returns null for unknown/malformed paths and for Settings overlay paths.
 */
export function parseRoute(path: string): AppRoute | null {
  const normalized = normalizePath(path);

  if (parseSettingsLocation(normalized)) return null;

  switch (normalized) {
    case "/":
    case "/today":
      return { name: "today" };
    case "/inbox":
      return { name: "inbox" };
    case "/upcoming":
      return { name: "upcoming" };
    case "/someday":
      return { name: "someday" };
    case "/completed":
      return { name: "completed" };
    case "/cancelled":
      return { name: "cancelled" };
    case "/search":
      return { name: "search" };
    case "/filters":
    case "/filters-labels":
      return { name: "filters-labels" };
    case "/calendar":
      return { name: "calendar" };
    case "/matrix":
      return { name: "matrix" };
    case "/stats":
      return { name: "stats" };
    case "/dopamine-menu":
      return { name: "dopamine-menu" };
    case "/timeblocking":
      return { name: "timeblocking" };
    default:
      break;
  }

  const segments = normalized.split("/").filter(Boolean);

  if (segments[0] === "filters" && segments[1] === "saved" && segments.length === 3) {
    const filterId = segments[2]!;
    if (!isUuid(filterId)) return null;
    return { name: "saved-filter", filterId };
  }

  if (segments[0] === "projects" && segments.length === 2) {
    const projectId = segments[1]!;
    if (!isUuid(projectId)) return null;
    return { name: "project", projectId, layout: "list" };
  }

  if (segments[0] === "projects" && segments.length === 3 && segments[2] === "board") {
    const projectId = segments[1]!;
    if (!isUuid(projectId)) return null;
    return { name: "project", projectId, layout: "board" };
  }

  if (segments[0] === "projects" && segments.length === 3 && segments[2] === "calendar") {
    const projectId = segments[1]!;
    if (!isUuid(projectId)) return null;
    return { name: "project", projectId, layout: "calendar" };
  }

  if (segments[0] === "tasks" && segments.length === 2) {
    const taskId = segments[1]!;
    if (!isUuid(taskId)) return null;
    return { name: "task", taskId };
  }

  return null;
}

/** Build the canonical pathname for a content route. */
export function routeToPath(route: AppRoute): string {
  switch (route.name) {
    case "today":
      return "/";
    case "inbox":
      return "/inbox";
    case "upcoming":
      return "/upcoming";
    case "someday":
      return "/someday";
    case "completed":
      return "/completed";
    case "cancelled":
      return "/cancelled";
    case "search":
      return "/search";
    case "filters-labels":
      return "/filters";
    case "saved-filter":
      return `/filters/saved/${route.filterId}`;
    case "project":
      if (route.layout === "board") return `/projects/${route.projectId}/board`;
      if (route.layout === "calendar") return `/projects/${route.projectId}/calendar`;
      return `/projects/${route.projectId}`;
    case "task":
      return `/tasks/${route.taskId}`;
    case "calendar":
      return "/calendar";
    case "matrix":
      return "/matrix";
    case "stats":
      return "/stats";
    case "dopamine-menu":
      return "/dopamine-menu";
    case "timeblocking":
      return "/timeblocking";
  }
}

/** Expand a simple view name into a route (ID-bearing views need a full AppRoute). */
export function viewToRoute(view: View): AppRoute | null {
  switch (view) {
    case "today":
    case "inbox":
    case "upcoming":
    case "someday":
    case "completed":
    case "cancelled":
    case "search":
    case "filters-labels":
    case "calendar":
    case "matrix":
    case "stats":
    case "dopamine-menu":
    case "timeblocking":
      return { name: view };
    case "saved-filter":
    case "project":
    case "task":
      return null;
  }
}

export function routeToView(route: AppRoute): View {
  return route.name;
}

/** @deprecated Prefer parseRoute; kept for existing chrome that only needs Today/Inbox. */
export function pathToView(path: string): View {
  const route = parseRoute(path);
  if (!route) return "today";
  return routeToView(route);
}

/** @deprecated Prefer routeToPath. */
export function viewToPath(view: View): string {
  const route = viewToRoute(view);
  return route ? routeToPath(route) : "/";
}

function readHistoryState(): HistoryState {
  const state = window.history.state;
  if (!state || typeof state !== "object") return null;
  const background = (state as { junbanBackground?: unknown }).junbanBackground;
  if (typeof background !== "string" || !background) return null;
  return { junbanBackground: background };
}

function resolveBackgroundRoute(settingsPath: boolean): AppRoute {
  if (!settingsPath) {
    return parseRoute(window.location.pathname) ?? todayRoute();
  }
  const fromState = readHistoryState()?.junbanBackground;
  if (fromState) {
    const parsed = parseRoute(fromState);
    if (parsed) return parsed;
  }
  return todayRoute();
}

function resolveSettingsLocation(): SettingsLocation {
  return parseSettingsLocation(window.location.pathname) ?? { open: false };
}

function coerceTarget(
  target: NavigateTarget,
): AppRoute | { name: "settings"; tab?: SettingsTabId | null } | null {
  if (typeof target === "string") {
    return viewToRoute(target);
  }
  if (target.name === "settings") {
    return target;
  }
  return target;
}

export function useRouting(): {
  route: AppRoute;
  view: View;
  settings: SettingsLocation;
  settingsOpen: boolean;
  navigate: (target: NavigateTarget) => void;
  openSettings: (tab?: SettingsTabId | null) => void;
  closeSettings: () => void;
  navigateSettings: (tab: SettingsTabId | null) => void;
  focusModeOpen: boolean;
  setFocusModeOpen: (open: boolean) => void;
} {
  const [route, setRoute] = useState<AppRoute>(() =>
    resolveBackgroundRoute(parseSettingsLocation(window.location.pathname) !== null),
  );
  const [settings, setSettings] = useState<SettingsLocation>(() => resolveSettingsLocation());
  const [focusModeOpen, setFocusModeOpenState] = useState(() => readFocusQuery());

  useEffect(() => {
    const handlePopState = () => {
      const settingsLoc = resolveSettingsLocation();
      setSettings(settingsLoc);
      setRoute(resolveBackgroundRoute(settingsLoc.open));
      setFocusModeOpenState(readFocusQuery());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Direct load of a settings URL: ensure history state carries a Today background.
  useEffect(() => {
    const settingsLoc = parseSettingsLocation(window.location.pathname);
    if (!settingsLoc) return;
    if (readHistoryState()?.junbanBackground) return;
    const background = routeToPath(todayRoute());
    window.history.replaceState(
      { junbanBackground: background },
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);

  const openSettings = useCallback((tab: SettingsTabId | null = null) => {
    const backgroundPath = parseSettingsLocation(window.location.pathname)
      ? (readHistoryState()?.junbanBackground ?? routeToPath(todayRoute()))
      : `${window.location.pathname}${window.location.search}` || "/";
    // Strip query from stored background path for route parsing; focus is not restored via settings.
    const backgroundRoutePath = backgroundPath.split("?")[0] || "/";
    const backgroundRoute = parseRoute(backgroundRoutePath) ?? todayRoute();
    const path = settingsToPath(tab);
    const state: HistoryState = { junbanBackground: routeToPath(backgroundRoute) };
    if (window.location.pathname !== path) {
      window.history.pushState(state, "", path);
    } else {
      window.history.replaceState(state, "", path);
    }
    setRoute(backgroundRoute);
    setSettings({ open: true, tab });
    setFocusModeOpenState(false);
  }, []);

  const closeSettings = useCallback(() => {
    const backgroundPath = readHistoryState()?.junbanBackground ?? routeToPath(todayRoute());
    const backgroundRoute = parseRoute(backgroundPath) ?? todayRoute();
    const path = routeToPath(backgroundRoute);
    if (`${window.location.pathname}` !== path) {
      window.history.pushState(null, "", path);
    } else {
      window.history.replaceState(null, "", path);
    }
    setRoute(backgroundRoute);
    setSettings({ open: false });
  }, []);

  const navigateSettings = useCallback((tab: SettingsTabId | null) => {
    const background =
      readHistoryState()?.junbanBackground ?? routeToPath(resolveBackgroundRoute(true));
    const path = settingsToPath(tab);
    const state: HistoryState = { junbanBackground: background };
    if (window.location.pathname !== path) {
      window.history.pushState(state, "", path);
    } else {
      window.history.replaceState(state, "", path);
    }
    setSettings({ open: true, tab });
  }, []);

  const navigate = useCallback(
    (target: NavigateTarget) => {
      const next = coerceTarget(target);
      if (!next) return;
      if (next.name === "settings") {
        openSettings(next.tab === undefined ? null : next.tab);
        return;
      }
      const path = routeToPath(next);
      const url = readFocusQuery() ? pathWithFocus(true, path, "") : path;
      if (`${window.location.pathname}${window.location.search}` !== url) {
        window.history.pushState(null, "", url);
      }
      setRoute(next);
      setSettings({ open: false });
      setFocusModeOpenState(readFocusQuery());
    },
    [openSettings],
  );

  const setFocusModeOpen = useCallback((open: boolean) => {
    const url = pathWithFocus(open);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState(readHistoryState(), "", url);
    }
    setFocusModeOpenState(open);
  }, []);

  const view = useMemo(() => routeToView(route), [route]);
  const settingsOpen = settings.open;

  return {
    route,
    view,
    settings,
    settingsOpen,
    navigate,
    openSettings,
    closeSettings,
    navigateSettings,
    focusModeOpen,
    setFocusModeOpen,
  };
}
