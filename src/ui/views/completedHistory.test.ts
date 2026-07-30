/**
 * P2-CLOSE-003: Completed history groups/sorts cancelled rows by updated_at
 * when completed_at is null.
 */
import { describe, expect, it } from "vitest";
import type { TaskDto } from "../api/client";
import { groupCompletedHistory, historyTimestamp, sortCompletedHistory } from "./completedHistory";

function makeTask(overrides: Partial<TaskDto> & Pick<TaskDto, "id" | "title" | "status">): TaskDto {
  return {
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
    revision: 1,
    completed_at: null,
    description: "",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    ...overrides,
  };
}

describe("completed history (P2-CLOSE-003)", () => {
  it("uses completed_at for completed tasks and updated_at when completed_at is null", () => {
    const completed = makeTask({
      id: "c1",
      title: "Done",
      status: "completed",
      completed_at: "2026-07-22T15:00:00Z",
      updated_at: "2026-07-22T15:00:00Z",
    });
    const cancelled = makeTask({
      id: "x1",
      title: "Dropped",
      status: "cancelled",
      completed_at: null,
      updated_at: "2026-07-23T09:30:00Z",
    });

    expect(historyTimestamp(completed)).toBe("2026-07-22T15:00:00Z");
    expect(historyTimestamp(cancelled)).toBe("2026-07-23T09:30:00Z");
  });

  it("sorts and groups completed + cancelled by known timestamps", () => {
    const olderCompleted = makeTask({
      id: "done-old",
      title: "Finished Monday",
      status: "completed",
      completed_at: "2026-07-21T11:00:00Z",
      updated_at: "2026-07-21T11:00:00Z",
    });
    const newerCancelled = makeTask({
      id: "cancel-new",
      title: "Cancelled Tuesday",
      status: "cancelled",
      completed_at: null,
      updated_at: "2026-07-22T16:45:00Z",
    });
    const sameDayCompleted = makeTask({
      id: "done-tue",
      title: "Finished Tuesday morning",
      status: "completed",
      completed_at: "2026-07-22T08:00:00Z",
      updated_at: "2026-07-22T08:00:00Z",
    });

    const sorted = sortCompletedHistory([olderCompleted, newerCancelled, sameDayCompleted]);
    expect(sorted.map((t) => t.id)).toEqual(["cancel-new", "done-tue", "done-old"]);

    const groups = groupCompletedHistory([olderCompleted, newerCancelled, sameDayCompleted]);
    expect(groups.map((g) => g.date)).toEqual(["2026-07-22", "2026-07-21"]);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["cancel-new", "done-tue"]);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["done-old"]);
  });
});
