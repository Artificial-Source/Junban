import { describe, it, expect } from "vitest";
import { parseRoute, routeToPath, routeToView, viewToRoute } from "./useRouting";

describe("parseRoute Phase 2 routes", () => {
  it("parses today", () => {
    expect(parseRoute("/")).toEqual({ name: "today" });
    expect(parseRoute("/today")).toEqual({ name: "today" });
  });

  it("parses inbox", () => {
    expect(parseRoute("/inbox")).toEqual({ name: "inbox" });
  });

  it("parses upcoming", () => {
    expect(parseRoute("/upcoming")).toEqual({ name: "upcoming" });
  });

  it("parses someday", () => {
    expect(parseRoute("/someday")).toEqual({ name: "someday" });
  });

  it("parses completed", () => {
    expect(parseRoute("/completed")).toEqual({ name: "completed" });
  });

  it("parses cancelled", () => {
    expect(parseRoute("/cancelled")).toEqual({ name: "cancelled" });
  });

  it("parses filters-labels", () => {
    expect(parseRoute("/filters")).toEqual({ name: "filters-labels" });
    expect(parseRoute("/filters-labels")).toEqual({ name: "filters-labels" });
  });

  it("parses saved-filter with valid UUID", () => {
    const uuid = "01234567-0123-4123-8123-0123456789ab";
    expect(parseRoute(`/filters/saved/${uuid}`)).toEqual({
      name: "saved-filter",
      filterId: uuid,
    });
  });

  it("rejects saved-filter with invalid UUID", () => {
    expect(parseRoute("/filters/saved/not-a-uuid")).toBeNull();
  });

  it("parses project list", () => {
    const uuid = "01234567-0123-4123-8123-0123456789ab";
    expect(parseRoute(`/projects/${uuid}`)).toEqual({
      name: "project",
      projectId: uuid,
      layout: "list",
    });
  });

  it("parses project board", () => {
    const uuid = "01234567-0123-4123-8123-0123456789ab";
    expect(parseRoute(`/projects/${uuid}/board`)).toEqual({
      name: "project",
      projectId: uuid,
      layout: "board",
    });
  });

  it("parses project calendar", () => {
    const uuid = "01234567-0123-4123-8123-0123456789ab";
    expect(parseRoute(`/projects/${uuid}/calendar`)).toEqual({
      name: "project",
      projectId: uuid,
      layout: "calendar",
    });
  });

  it("parses task page", () => {
    const uuid = "01234567-0123-4123-8123-0123456789ab";
    expect(parseRoute(`/tasks/${uuid}`)).toEqual({
      name: "task",
      taskId: uuid,
    });
  });

  it("parses Phase 3 first-party routes", () => {
    expect(parseRoute("/calendar")).toEqual({ name: "calendar" });
    expect(parseRoute("/matrix")).toEqual({ name: "matrix" });
    expect(parseRoute("/stats")).toEqual({ name: "stats" });
    expect(parseRoute("/dopamine-menu")).toEqual({ name: "dopamine-menu" });
    expect(parseRoute("/timeblocking")).toEqual({ name: "timeblocking" });
  });

  it("returns null for unknown routes", () => {
    expect(parseRoute("/unknown")).toBeNull();
    expect(parseRoute("/focus")).toBeNull();
  });
});

describe("routeToPath", () => {
  it("builds paths for all routes", () => {
    expect(routeToPath({ name: "today" })).toBe("/");
    expect(routeToPath({ name: "inbox" })).toBe("/inbox");
    expect(routeToPath({ name: "upcoming" })).toBe("/upcoming");
    expect(routeToPath({ name: "someday" })).toBe("/someday");
    expect(routeToPath({ name: "completed" })).toBe("/completed");
    expect(routeToPath({ name: "cancelled" })).toBe("/cancelled");
    expect(routeToPath({ name: "search" })).toBe("/search");
    expect(routeToPath({ name: "filters-labels" })).toBe("/filters");
  });

  it("builds project board and calendar paths", () => {
    expect(
      routeToPath({
        name: "project",
        projectId: "01234567-0123-4123-8123-0123456789ab",
        layout: "board",
      }),
    ).toBe("/projects/01234567-0123-4123-8123-0123456789ab/board");
    expect(
      routeToPath({
        name: "project",
        projectId: "01234567-0123-4123-8123-0123456789ab",
        layout: "calendar",
      }),
    ).toBe("/projects/01234567-0123-4123-8123-0123456789ab/calendar");
  });

  it("builds Phase 3 first-party paths", () => {
    expect(routeToPath({ name: "calendar" })).toBe("/calendar");
    expect(routeToPath({ name: "matrix" })).toBe("/matrix");
    expect(routeToPath({ name: "stats" })).toBe("/stats");
    expect(routeToPath({ name: "dopamine-menu" })).toBe("/dopamine-menu");
    expect(routeToPath({ name: "timeblocking" })).toBe("/timeblocking");
  });
});

describe("routeToView", () => {
  it("converts routes to view names", () => {
    expect(routeToView({ name: "today" })).toBe("today");
    expect(routeToView({ name: "inbox" })).toBe("inbox");
    expect(routeToView({ name: "project", projectId: "x", layout: "list" })).toBe("project");
  });
});

describe("viewToRoute", () => {
  it("converts simple views to routes", () => {
    expect(viewToRoute("today")).toEqual({ name: "today" });
    expect(viewToRoute("inbox")).toEqual({ name: "inbox" });
  });

  it("returns null for ID-bearing views", () => {
    expect(viewToRoute("project")).toBeNull();
    expect(viewToRoute("task")).toBeNull();
    expect(viewToRoute("saved-filter")).toBeNull();
  });
});

import { pathWithFocus, readFocusQuery } from "./useRouting";

describe("focus query helpers", () => {
  it("reads and builds ?focus=1", () => {
    expect(readFocusQuery("?focus=1")).toBe(true);
    expect(readFocusQuery("")).toBe(false);
    expect(pathWithFocus(true, "/today", "")).toBe("/today?focus=1");
    expect(pathWithFocus(false, "/today", "?focus=1")).toBe("/today");
  });
});
