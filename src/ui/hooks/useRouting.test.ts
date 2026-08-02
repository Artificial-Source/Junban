import { describe, expect, it } from "vitest";
import {
  parseRoute,
  parseSettingsLocation,
  pathToView,
  routeToPath,
  settingsToPath,
  viewToPath,
  viewToRoute,
} from "./useRouting";

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
    "/settings/unknown",
    "/focus",
    "/projects/not-a-uuid",
    "/tasks/nope",
    "/filters/saved/bad",
    "/projects//board",
  ])("rejects %s", (path) => {
    expect(parseRoute(path)).toBeNull();
  });
});

describe("Phase 4 settings route matrix", () => {
  it("parses the closed settings tab set", () => {
    expect(parseSettingsLocation("/settings")).toEqual({ open: true, tab: null });
    expect(parseSettingsLocation("/settings/essentials")).toEqual({
      open: true,
      tab: "essentials",
    });
    expect(parseSettingsLocation("/settings/appearance")).toEqual({
      open: true,
      tab: "appearance",
    });
    expect(parseSettingsLocation("/settings/features")).toEqual({ open: true, tab: "features" });
    expect(parseSettingsLocation("/settings/keyboard")).toEqual({ open: true, tab: "keyboard" });
    expect(parseSettingsLocation("/settings/templates")).toEqual({ open: true, tab: "templates" });
    expect(parseSettingsLocation("/settings/data")).toEqual({ open: true, tab: "data" });
    expect(parseSettingsLocation("/settings/hosted")).toEqual({ open: true, tab: "hosted" });
    expect(parseSettingsLocation("/settings/diagnostics")).toEqual({
      open: true,
      tab: "diagnostics",
    });
  });

  it("rejects hidden legacy tabs and unknown segments", () => {
    expect(parseSettingsLocation("/settings/ai")).toBeNull();
    expect(parseSettingsLocation("/settings/voice")).toBeNull();
    expect(parseSettingsLocation("/settings/plugins")).toBeNull();
    expect(parseSettingsLocation("/settings/about")).toBeNull();
    expect(parseSettingsLocation("/settings/general")).toBeNull();
    expect(parseSettingsLocation("/inbox")).toBeNull();
  });

  it("builds canonical settings paths", () => {
    expect(settingsToPath(null)).toBe("/settings");
    expect(settingsToPath("essentials")).toBe("/settings/essentials");
    expect(settingsToPath("data")).toBe("/settings/data");
    expect(settingsToPath("templates")).toBe("/settings/templates");
  });

  it("keeps content routes separate from settings overlay paths", () => {
    expect(parseRoute("/settings")).toBeNull();
    expect(parseRoute("/settings/appearance")).toBeNull();
    expect(parseRoute("/inbox")).toEqual({ name: "inbox" });
  });
});

describe("view helpers", () => {
  it("maps views without settings", () => {
    expect(viewToRoute("today")).toEqual({ name: "today" });
    expect(pathToView("/inbox")).toBe("inbox");
    expect(viewToPath("inbox")).toBe("/inbox");
    expect(pathToView("/settings")).toBe("today");
  });
});
