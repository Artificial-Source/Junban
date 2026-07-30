import { describe, expect, it } from "vitest";
import { parseRoute, pathToView, routeToPath, viewToPath, viewToRoute } from "./useRouting";

const FILTER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

describe("parseRoute / routeToPath round trips", () => {
  it.each([
    ["/", { name: "today" as const }],
    ["/today", { name: "today" as const }],
    ["/inbox", { name: "inbox" as const }],
    ["/upcoming", { name: "upcoming" as const }],
    ["/someday", { name: "someday" as const }],
    ["/completed", { name: "completed" as const }],
    ["/cancelled", { name: "cancelled" as const }],
    ["/search", { name: "search" as const }],
    ["/filters", { name: "filters-labels" as const }],
    ["/filters-labels", { name: "filters-labels" as const }],
    [`/filters/saved/${FILTER_ID}`, { name: "saved-filter" as const, filterId: FILTER_ID }],
    [
      `/projects/${PROJECT_ID}`,
      { name: "project" as const, projectId: PROJECT_ID, layout: "list" as const },
    ],
    [
      `/projects/${PROJECT_ID}/board`,
      { name: "project" as const, projectId: PROJECT_ID, layout: "board" as const },
    ],
    [`/tasks/${TASK_ID}`, { name: "task" as const, taskId: TASK_ID }],
  ])("parses %s", (path, route) => {
    expect(parseRoute(path)).toEqual(route);
    // Canonical path may collapse aliases (/today -> /, /filters-labels -> /filters).
    expect(parseRoute(routeToPath(route))).toEqual(
      route.name === "today"
        ? { name: "today" }
        : route.name === "filters-labels"
          ? { name: "filters-labels" }
          : route,
    );
  });

  it("builds canonical paths", () => {
    expect(routeToPath({ name: "today" })).toBe("/");
    expect(routeToPath({ name: "filters-labels" })).toBe("/filters");
    expect(routeToPath({ name: "project", projectId: PROJECT_ID, layout: "board" })).toBe(
      `/projects/${PROJECT_ID}/board`,
    );
    expect(routeToPath({ name: "saved-filter", filterId: FILTER_ID })).toBe(
      `/filters/saved/${FILTER_ID}`,
    );
  });
});

describe("parseRoute rejection", () => {
  it.each([
    "/unknown",
    "/settings",
    "/focus",
    "/projects/not-a-uuid",
    "/projects/11111111-1111-4111-8111-111111111111/calendar",
    "/tasks/nope",
    "/filters/saved/bad",
    "/projects//board",
  ])("rejects %s", (path) => {
    expect(parseRoute(path)).toBeNull();
  });
});

describe("pathToView / viewToPath compatibility", () => {
  it("maps /inbox to inbox", () => {
    expect(pathToView("/inbox")).toBe("inbox");
  });

  it("maps / to today", () => {
    expect(pathToView("/")).toBe("today");
  });

  it("maps /today to today", () => {
    expect(pathToView("/today")).toBe("today");
  });

  it("defaults unknown paths to today for legacy chrome", () => {
    expect(pathToView("/unknown")).toBe("today");
  });

  it("maps today to /", () => {
    expect(viewToPath("today")).toBe("/");
  });

  it("maps inbox to /inbox", () => {
    expect(viewToPath("inbox")).toBe("/inbox");
  });

  it("refuses to invent ids for resource views", () => {
    expect(viewToRoute("project")).toBeNull();
    expect(viewToRoute("task")).toBeNull();
    expect(viewToRoute("saved-filter")).toBeNull();
  });
});
