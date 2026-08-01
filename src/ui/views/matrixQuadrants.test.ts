import { describe, expect, it } from "vitest";
import type { TaskDto } from "../api/client";
import { classifyMatrixTask, groupMatrixTasks, matrixDropPatch } from "./matrixQuadrants";

function task(partial: Partial<TaskDto> & { id: string; title: string }): TaskDto {
  return {
    description: "",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    status: "pending",
    created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:00:00Z",
    revision: 1,
    ...partial,
  };
}

describe("matrix quadrant mapping", () => {
  const today = "2026-07-23";

  it("classifies priority and civil urgency into four quadrants", () => {
    expect(
      classifyMatrixTask(task({ id: "1", title: "Q1", priority: 1, due_date: today }), today),
    ).toBe("q1");
    expect(
      classifyMatrixTask(task({ id: "2", title: "Q2", priority: 2, due_date: null }), today),
    ).toBe("q2");
    expect(
      classifyMatrixTask(
        task({ id: "3", title: "Q3", priority: 3, due_date: "2026-07-20" }),
        today,
      ),
    ).toBe("q3");
    expect(
      classifyMatrixTask(task({ id: "4", title: "Q4", priority: 4, due_date: null }), today),
    ).toBe("q4");
  });

  it("writes civil due_date strings on drop, never ISO timestamps", () => {
    expect(matrixDropPatch("q1", today)).toEqual({ priority: 1, due_date: today });
    expect(matrixDropPatch("q2", today)).toEqual({ priority: 1, due_date: null });
    expect(matrixDropPatch("q3", today)).toEqual({ priority: 3, due_date: today });
    expect(matrixDropPatch("q4", today)).toEqual({ priority: 3, due_date: null });

    for (const quadrant of ["q1", "q2", "q3", "q4"] as const) {
      const patch = matrixDropPatch(quadrant, today);
      if (patch.due_date != null) {
        expect(patch.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(patch.due_date).not.toContain("T");
      }
    }
  });

  it("groups only pending tasks", () => {
    const grouped = groupMatrixTasks(
      [
        task({ id: "p", title: "Pending", priority: 1, due_date: today }),
        task({ id: "c", title: "Done", priority: 1, due_date: today, status: "completed" }),
      ],
      today,
    );
    expect(grouped.q1.map((t) => t.id)).toEqual(["p"]);
    expect(grouped.q2).toEqual([]);
  });
});
