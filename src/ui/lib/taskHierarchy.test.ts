import { describe, expect, it } from "vitest";
import {
  completeOutdentPlan,
  depthsFromParentGraph,
  findIndentParentId,
  outdentMoveRequest,
  planOutdent,
  resolveIndentMove,
  wouldCreateParentCycle,
} from "./taskHierarchy";

function t(id: string, parent_id: string | null = null) {
  return { id, parent_id };
}

describe("depthsFromParentGraph", () => {
  it("computes multi-level depth from the loaded parent graph", () => {
    const tasks = [t("a"), t("b", "a"), t("c", "b"), t("d")];
    const depths = depthsFromParentGraph(tasks);
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(1);
    expect(depths.get("c")).toBe(2);
    expect(depths.get("d")).toBe(0);
  });

  it("treats missing parents as depth 1 rather than hard-coding every child as 1", () => {
    const tasks = [t("child", "missing-parent"), t("grand", "child")];
    const depths = depthsFromParentGraph(tasks);
    expect(depths.get("child")).toBe(1);
    expect(depths.get("grand")).toBe(2);
  });
});

describe("findIndentParentId / resolveIndentMove", () => {
  it("indents under the nearest preceding sibling with the same parent", () => {
    const tasks = [t("a"), t("b"), t("c")];
    expect(findIndentParentId(tasks, "c")).toBe("b");
    expect(resolveIndentMove(tasks, "c")).toEqual({
      parent_id: "b",
      order: "last",
    });
  });

  it("skips intervening nested children when finding the preceding sibling", () => {
    // a
    //   a1 (child of a)
    // b  ← indent target for c should still be a? No — b's sibling is a.
    // c
    const tasks = [t("a"), t("a1", "a"), t("b"), t("c")];
    expect(findIndentParentId(tasks, "c")).toBe("b");
    expect(findIndentParentId(tasks, "b")).toBe("a");
    // a1's preceding sibling under parent a: none
    expect(findIndentParentId(tasks, "a1")).toBeNull();
  });

  it("returns null for the first visible task", () => {
    expect(findIndentParentId([t("a"), t("b")], "a")).toBeNull();
    expect(resolveIndentMove([t("a")], "a")).toBeNull();
  });

  it("refuses a cycle when the candidate is under the task", () => {
    // Should not happen with sibling search, but guard explicitly.
    const tasks = [t("a"), t("b", "a")];
    expect(wouldCreateParentCycle(tasks, "a", "b")).toBe(true);
    expect(wouldCreateParentCycle(tasks, "b", "a")).toBe(false);
  });
});

describe("planOutdent", () => {
  it("promotes after the former parent with grandparent as the new parent", () => {
    const tasks = [t("root"), t("mid", "root"), t("leaf", "mid")];
    const plan = planOutdent(tasks, "leaf");
    expect(plan).toEqual({
      parentId: "root",
      afterTaskId: "mid",
      needsParentFetch: false,
    });
    expect(outdentMoveRequest(plan!)).toEqual({
      parent_id: "root",
      order: { after: { task_id: "mid" } },
    });
  });

  it("outdents a root-child to null parent after the former parent", () => {
    const tasks = [t("a"), t("b", "a")];
    const plan = planOutdent(tasks, "b");
    expect(plan).toEqual({
      parentId: null,
      afterTaskId: "a",
      needsParentFetch: false,
    });
  });

  it("flags a focused parent fetch when the parent is not in the visible list", () => {
    const tasks = [t("leaf", "missing-parent")];
    const plan = planOutdent(tasks, "leaf");
    expect(plan).toEqual({
      parentId: null,
      afterTaskId: "missing-parent",
      needsParentFetch: true,
    });
    const completed = completeOutdentPlan(plan!, t("missing-parent", "grand"));
    expect(completed).toEqual({
      parentId: "grand",
      afterTaskId: "missing-parent",
      needsParentFetch: false,
    });
  });

  it("returns null when the task is already a root", () => {
    expect(planOutdent([t("a")], "a")).toBeNull();
  });
});
