/**
 * Real-path routing using the History API.
 * The URL fragment remains reserved for access-token bootstrap.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** Structured application route. */
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

export type NavigateTarget = View | AppRoute;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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
  // Drop empty focus-only noise.
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

/**
 * Parse a pathname into a route.
 * Returns null for unknown or malformed paths (including invalid UUIDs).
 */
export function parseRoute(path: string): AppRoute | null {
  const normalized = normalizePath(path);

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

/** Build the canonical pathname for a route. */
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

function coerceTarget(target: NavigateTarget): AppRoute | null {
  if (typeof target === "string") {
    return viewToRoute(target);
  }
  return target;
}

export function useRouting(): {
  route: AppRoute;
  view: View;
  navigate: (target: NavigateTarget) => void;
  focusModeOpen: boolean;
  setFocusModeOpen: (open: boolean) => void;
} {
  const [route, setRoute] = useState<AppRoute>(
    () =>
      parseRoute(window.location.pathname) ?? {
        name: "today",
      },
  );
  const [focusModeOpen, setFocusModeOpenState] = useState(() => readFocusQuery());

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname) ?? { name: "today" });
      setFocusModeOpenState(readFocusQuery());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((target: NavigateTarget) => {
    const next = coerceTarget(target);
    if (!next) return;
    const path = routeToPath(next);
    // Preserve focus query across ordinary navigation only when already open.
    const url = readFocusQuery() ? pathWithFocus(true, path, "") : path;
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState(null, "", url);
      setRoute(next);
      setFocusModeOpenState(readFocusQuery());
    }
  }, []);

  const setFocusModeOpen = useCallback((open: boolean) => {
    const url = pathWithFocus(open);
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState(null, "", url);
    }
    setFocusModeOpenState(open);
  }, []);

  const view = useMemo(() => routeToView(route), [route]);

  return { route, view, navigate, focusModeOpen, setFocusModeOpen };
}
