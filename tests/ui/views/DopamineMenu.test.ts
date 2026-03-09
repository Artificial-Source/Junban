import { describe, it, expect } from "vitest";
import type { Task } from "../../../src/core/types.js";
import { filterQuickWins, sortQuickWins } from "../../../src/ui/views/DopamineMenu.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Test task",
    status: "pending",
    priority: null,
    dueDate: null,
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

describe("DopamineMenu filter logic", () => {
  it("includes tasks with estimatedMinutes <= 15", () => {
    const tasks = [
      makeTask({ id: "a", estimatedMinutes: 5 }),
      makeTask({ id: "b", estimatedMinutes: 15 }),
      makeTask({ id: "c", estimatedMinutes: 16 }),
    ];
    const result = filterQuickWins(tasks);
    expect(result.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("includes tasks with priority >= 3 (low priority = easy)", () => {
    const tasks = [
      makeTask({ id: "a", priority: 3 }),
      makeTask({ id: "b", priority: 4 }),
      makeTask({ id: "c", priority: 2 }),
      makeTask({ id: "d", priority: 1 }),
    ];
    const result = filterQuickWins(tasks);
    expect(result.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("includes tasks matching ANY criterion (OR logic)", () => {
    const tasks = [
      makeTask({ id: "a", estimatedMinutes: 10, priority: 1 }),
      makeTask({ id: "b", estimatedMinutes: 30, priority: 4 }),
      makeTask({ id: "c", estimatedMinutes: 5, priority: 3 }),
    ];
    const result = filterQuickWins(tasks);
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes tasks matching neither criterion", () => {
    const tasks = [
      makeTask({ id: "a", estimatedMinutes: 30, priority: 1 }),
      makeTask({ id: "b", estimatedMinutes: null, priority: 2 }),
      makeTask({ id: "c", estimatedMinutes: null, priority: null }),
    ];
    const result = filterQuickWins(tasks);
    expect(result).toEqual([]);
  });

  it("only includes pending tasks", () => {
    const tasks = [
      makeTask({ id: "a", estimatedMinutes: 5, status: "pending" }),
      makeTask({ id: "b", estimatedMinutes: 5, status: "completed" }),
      makeTask({ id: "c", estimatedMinutes: 5, status: "cancelled" }),
    ];
    const result = filterQuickWins(tasks);
    expect(result.map((t) => t.id)).toEqual(["a"]);
  });

  it("returns empty when no tasks match", () => {
    const tasks = [makeTask({ id: "a", estimatedMinutes: 60, priority: 1 })];
    const result = filterQuickWins(tasks);
    expect(result).toEqual([]);
  });
});

describe("DopamineMenu sort logic", () => {
  it("sorts by estimatedMinutes ascending", () => {
    const tasks = [
      makeTask({ id: "a", estimatedMinutes: 15 }),
      makeTask({ id: "b", estimatedMinutes: 5 }),
      makeTask({ id: "c", estimatedMinutes: 10 }),
    ];
    const result = sortQuickWins(tasks);
    expect(result.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("puts null estimatedMinutes last", () => {
    const tasks = [
      makeTask({ id: "a", estimatedMinutes: null, priority: 3 }),
      makeTask({ id: "b", estimatedMinutes: 10 }),
      makeTask({ id: "c", estimatedMinutes: null, priority: 4 }),
    ];
    const result = sortQuickWins(tasks);
    expect(result.map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the original array", () => {
    const tasks = [
      makeTask({ id: "a", estimatedMinutes: 15 }),
      makeTask({ id: "b", estimatedMinutes: 5 }),
    ];
    const original = [...tasks];
    sortQuickWins(tasks);
    expect(tasks.map((t) => t.id)).toEqual(original.map((t) => t.id));
  });
});
