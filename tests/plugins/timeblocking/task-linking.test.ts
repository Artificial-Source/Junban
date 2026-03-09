import { describe, it, expect } from "vitest";
import {
  getBlocksForTask,
  getBlockForTaskOnDate,
  isTaskScheduled,
} from "../../../src/plugins/builtin/timeblocking/task-linking.js";
import type { TimeBlock } from "../../../src/plugins/builtin/timeblocking/types.js";

function makeBlock(overrides: Partial<TimeBlock> = {}): TimeBlock {
  return {
    id: "block-1",
    title: "Focus",
    date: "2026-03-10",
    startTime: "09:00",
    endTime: "10:00",
    locked: false,
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

describe("getBlocksForTask", () => {
  it("finds all blocks linked to a task", () => {
    const blocks = [
      makeBlock({ id: "b1", taskId: "task-1", date: "2026-03-10" }),
      makeBlock({ id: "b2", taskId: "task-1", date: "2026-03-11" }),
      makeBlock({ id: "b3", taskId: "task-2", date: "2026-03-10" }),
    ];
    expect(getBlocksForTask(blocks, "task-1")).toHaveLength(2);
  });

  it("returns empty for unlinked task", () => {
    const blocks = [makeBlock({ taskId: "task-1" })];
    expect(getBlocksForTask(blocks, "task-999")).toEqual([]);
  });

  it("ignores blocks without taskId", () => {
    const blocks = [makeBlock({ taskId: undefined })];
    expect(getBlocksForTask(blocks, "task-1")).toEqual([]);
  });
});

describe("getBlockForTaskOnDate", () => {
  it("finds block for task on specific date", () => {
    const blocks = [
      makeBlock({ id: "b1", taskId: "task-1", date: "2026-03-10" }),
      makeBlock({ id: "b2", taskId: "task-1", date: "2026-03-11" }),
    ];
    const result = getBlockForTaskOnDate(blocks, "task-1", "2026-03-11");
    expect(result?.id).toBe("b2");
  });

  it("returns null when no match", () => {
    const blocks = [makeBlock({ taskId: "task-1", date: "2026-03-10" })];
    expect(getBlockForTaskOnDate(blocks, "task-1", "2026-03-12")).toBeNull();
  });
});

describe("isTaskScheduled", () => {
  it("returns true if task has future block", () => {
    const blocks = [makeBlock({ taskId: "task-1", date: "2026-03-15" })];
    expect(isTaskScheduled(blocks, "task-1", "2026-03-10")).toBe(true);
  });

  it("returns true if task has block today", () => {
    const blocks = [makeBlock({ taskId: "task-1", date: "2026-03-10" })];
    expect(isTaskScheduled(blocks, "task-1", "2026-03-10")).toBe(true);
  });

  it("returns false if task only has past blocks", () => {
    const blocks = [makeBlock({ taskId: "task-1", date: "2026-03-05" })];
    expect(isTaskScheduled(blocks, "task-1", "2026-03-10")).toBe(false);
  });

  it("returns false for unlinked task", () => {
    const blocks = [makeBlock({ taskId: "task-2", date: "2026-03-15" })];
    expect(isTaskScheduled(blocks, "task-1", "2026-03-10")).toBe(false);
  });
});
