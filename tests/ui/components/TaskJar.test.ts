import { describe, it, expect } from "vitest";
import type { Task } from "../../../src/core/types.js";
import { buildJarPool, pickRandom } from "../../../src/ui/components/TaskJar.js";

const today = new Date().toISOString().split("T")[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    status: "pending",
    priority: null,
    dueDate: `${today}T10:00:00.000Z`,
    dueTime: false,
    projectId: null,
    parentId: null,
    tags: [],
    sortOrder: 0,
    recurrence: null,
    description: null,
    completedAt: null,
    estimatedMinutes: null,
    actualMinutes: null,
    deadline: null,
    isSomeday: false,
    sectionId: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("TaskJar pool building", () => {
  it("includes pending tasks due today", () => {
    const tasks = [makeTask({ id: "a", dueDate: `${today}T10:00:00.000Z` })];
    const pool = buildJarPool(tasks);
    expect(pool.map((t) => t.id)).toEqual(["a"]);
  });

  it("includes overdue tasks", () => {
    const tasks = [makeTask({ id: "a", dueDate: `${yesterday}T10:00:00.000Z` })];
    const pool = buildJarPool(tasks);
    expect(pool.map((t) => t.id)).toEqual(["a"]);
  });

  it("excludes tasks due in the future", () => {
    const tasks = [makeTask({ id: "a", dueDate: `${tomorrow}T10:00:00.000Z` })];
    const pool = buildJarPool(tasks);
    expect(pool).toEqual([]);
  });

  it("excludes completed tasks", () => {
    const tasks = [makeTask({ id: "a", status: "completed", dueDate: `${today}T10:00:00.000Z` })];
    const pool = buildJarPool(tasks);
    expect(pool).toEqual([]);
  });

  it("excludes tasks with no due date", () => {
    const tasks = [makeTask({ id: "a", dueDate: null })];
    const pool = buildJarPool(tasks);
    expect(pool).toEqual([]);
  });

  it("returns empty for no tasks", () => {
    expect(buildJarPool([])).toEqual([]);
  });
});

describe("TaskJar random selection", () => {
  it("returns null for empty pool", () => {
    expect(pickRandom([])).toBeNull();
  });

  it("returns the only task for pool of 1", () => {
    const task = makeTask({ id: "only" });
    expect(pickRandom([task])?.id).toBe("only");
  });

  it("selects from the pool for 2+ tasks", () => {
    const pool = [makeTask({ id: "a" }), makeTask({ id: "b" }), makeTask({ id: "c" })];
    const result = pickRandom(pool);
    expect(result).not.toBeNull();
    expect(pool.some((t) => t.id === result!.id)).toBe(true);
  });

  it("can exclude the current task when shaking again", () => {
    const pool = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    // With exclude, should always pick the other one
    const result = pickRandom(pool, "a");
    expect(result?.id).toBe("b");
  });

  it("falls back to the pool if all excluded", () => {
    const pool = [makeTask({ id: "a" })];
    // Excluding the only item falls back to pool[0]
    const result = pickRandom(pool, "a");
    expect(result?.id).toBe("a");
  });
});
