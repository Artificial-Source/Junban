/**
 * Real-path routing using the History API.
 * The URL fragment remains reserved for access-token bootstrap.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Simple view names used by the current chrome (Today/Inbox) and Phase 2 destinations. */
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
  | "task";

/** Structured application route. Later-phase destinations are intentionally absent. */
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
  | { name: "project"; projectId: string; layout: "list" | "board" }
  | { name: "task"; taskId: string };

export type NavigateTarget = View | AppRoute;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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
 * Parse a pathname into a Phase 2 route.
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

  // Calendar project layout is Phase 3 — reject rather than silently map.
  if (segments[0] === "projects" && segments.length === 3 && segments[2] === "calendar") {
    return null;
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
      return route.layout === "board"
        ? `/projects/${route.projectId}/board`
        : `/projects/${route.projectId}`;
    case "task":
      return `/tasks/${route.taskId}`;
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
} {
  const [route, setRoute] = useState<AppRoute>(
    () =>
      parseRoute(window.location.pathname) ?? {
        name: "today",
      },
  );

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname) ?? { name: "today" });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((target: NavigateTarget) => {
    const next = coerceTarget(target);
    if (!next) return;
    const path = routeToPath(next);
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
      setRoute(next);
    }
  }, []);

  const view = useMemo(() => routeToView(route), [route]);

  return { route, view, navigate };
}
