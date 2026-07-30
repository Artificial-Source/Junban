import { describe, expect, it } from "vitest";
import { taskListParamsFromParsedFilter } from "./filterQueryParams";
import type { ParsedFilterResponse } from "../api/client";

function filter(partial: Partial<ParsedFilterResponse["filter"]>): ParsedFilterResponse["filter"] {
  return {
    statuses: [],
    tag_names: [],
    ...partial,
  };
}

describe("taskListParamsFromParsedFilter", () => {
  const catalog = {
    tags: [
      { id: "tag-a", name: "alpha" },
      { id: "tag-b", name: "beta" },
    ],
    projects: [{ id: "proj-1", name: "Workbench" }],
  };

  it("resolves multiple tags, statuses, and project together", () => {
    const result = taskListParamsFromParsedFilter(
      filter({
        statuses: ["pending", "completed"],
        tag_names: ["Alpha", "beta"],
        project_name: "workbench",
        priority: 1,
        overdue: true,
        search: "report",
      }),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.status).toBe("pending,completed");
    expect(result.params.tag_ids).toBe("tag-a,tag-b");
    expect(result.params.project_id).toBe("proj-1");
    expect(result.params.priority).toBe(1);
    expect(result.params.overdue).toBe(true);
    expect(result.params.search).toBe("report");
    expect(result.params.tag_id).toBeUndefined();
  });

  it("surfaces unknown and ambiguous names without emitting params", () => {
    const missing = taskListParamsFromParsedFilter(filter({ tag_names: ["nope"] }), catalog);
    expect(missing).toEqual({
      ok: false,
      error: 'Unknown tag "nope".',
    });

    const ambiguous = taskListParamsFromParsedFilter(filter({ project_name: "Work" }), {
      tags: [],
      projects: [
        { id: "p1", name: "Work" },
        { id: "p2", name: "work" },
      ],
    });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.error).toContain("Ambiguous project");
  });
});
