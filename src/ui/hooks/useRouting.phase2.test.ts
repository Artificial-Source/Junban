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

  it("rejects project calendar (Phase 3)", () => {
    const uuid = "01234567-0123-4123-8123-0123456789ab";
    expect(parseRoute(`/projects/${uuid}/calendar`)).toBeNull();
  });

  it("parses task page", () => {
    const uuid = "01234567-0123-4123-8123-0123456789ab";
    expect(parseRoute(`/tasks/${uuid}`)).toEqual({
      name: "task",
      taskId: uuid,
    });
  });

  it("returns null for unknown routes", () => {
    expect(parseRoute("/unknown")).toBeNull();
    expect(parseRoute("/calendar")).toBeNull();
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

  it("builds project board path", () => {
    expect(
      routeToPath({
        name: "project",
        projectId: "01234567-0123-4123-8123-0123456789ab",
        layout: "board",
      }),
    ).toBe("/projects/01234567-0123-4123-8123-0123456789ab/board");
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
