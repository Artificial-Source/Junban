import { describe, expect, it } from "vitest";
import type { CommittedEventDto, TaskDto } from "../api/client";
import { applyTaskEventToList, nextStateFromListSnapshot, removeTasksByIds } from "./useTaskQuery";

function makeTask(overrides: Partial<TaskDto> & Pick<TaskDto, "id" | "title">): TaskDto {
  return {
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
    status: "pending",
    revision: 1,
    due_date: null,
    completed_at: null,
    description: "",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    ...overrides,
  };
}

function makeEvent(
  task: TaskDto | null,
  revision: number,
  eventType: string,
  overrides: Partial<CommittedEventDto> = {},
): CommittedEventDto {
  return {
    event_type: eventType,
    occurred_at: "2026-07-28T00:00:00Z",
    operation_id: "op-test-1",
    revision,
    affected: task ? { task_ids: [task.id] } : {},
    resync: { tasks: false, catalog: false, settings: false },
    primary: task ? { resource_type: "task", id: task.id } : null,
    snapshot: task ? { resource_type: "task", task } : null,
    ...overrides,
  };
}

describe("pagination snapshot helpers", () => {
  it("rejects stale pages and keeps next_cursor metadata", () => {
    const accepted = nextStateFromListSnapshot(2, {
      revision: 4,
      as_of_date: "2026-07-29",
      tasks: [makeTask({ id: "a", title: "A", revision: 4 })],
      next_cursor: "cursor-2",
    });
    expect(accepted).toEqual({
      revision: 4,
      as_of_date: "2026-07-29",
      tasks: [makeTask({ id: "a", title: "A", revision: 4 })],
      next_cursor: "cursor-2",
    });
    expect(
      nextStateFromListSnapshot(4, {
        revision: 3,
        as_of_date: "2026-07-29",
        tasks: [],
        next_cursor: null,
      }),
    ).toBeNull();
  });
});

describe("applyTaskEventToList", () => {
  it("removes deleted ids without a full refresh when resync.tasks is false", () => {
    const tasks = [makeTask({ id: "a", title: "A" }), makeTask({ id: "b", title: "B" })];
    const result = applyTaskEventToList(tasks, 1, {
      revision: 2,
      operation_id: "op",
      event_type: "task.deleted",
      occurred_at: "2026-07-28T00:00:00Z",
      affected: { task_ids: ["a"] },
      resync: { tasks: false, catalog: false, settings: false },
      snapshot: null,
      primary: { resource_type: "task", id: "a" },
    });
    expect(result.tasks.map((task) => task.id)).toEqual(["b"]);
    expect(result.needsRefresh).toBe(false);
    expect(removeTasksByIds(tasks, ["a", "missing"]).map((task) => task.id)).toEqual(["b"]);
  });

  it("requires refresh for cascade resync scopes", () => {
    const tasks = [makeTask({ id: "a", title: "A" })];
    const result = applyTaskEventToList(tasks, 1, {
      revision: 5,
      operation_id: "op",
      event_type: "task.completed",
      occurred_at: "2026-07-28T00:00:00Z",
      affected: { task_ids: ["a", "child"] },
      resync: { tasks: true, catalog: false, settings: false },
      snapshot: null,
      primary: { resource_type: "task", id: "a" },
    });
    expect(result.needsRefresh).toBe(true);
  });

  it("does not upsert a create into a view-scoped list; asks for one coalesced refresh", () => {
    const visible = makeTask({ id: "a", title: "A", project_id: "project-a" });
    const created = makeTask({
      id: "b",
      title: "Other project",
      project_id: "project-b",
      revision: 2,
    });
    const result = applyTaskEventToList([visible], 1, makeEvent(created, 2, "task.created"));
    expect(result.needsRefresh).toBe(true);
    expect(result.tasks.map((task) => task.id)).toEqual(["a"]);
  });

  it("surfaces template.applied via coalesced refresh instead of a blind insert", () => {
    const applied = makeTask({ id: "from-template", title: "Templated", revision: 4 });
    const result = applyTaskEventToList([], 3, makeEvent(applied, 4, "template.applied"));
    expect(result.needsRefresh).toBe(true);
    expect(result.tasks).toEqual([]);
  });

  it("refreshes when a visible task changes project membership", () => {
    const visible = makeTask({ id: "a", title: "A", project_id: "project-a", revision: 1 });
    const moved = makeTask({
      id: "a",
      title: "A",
      project_id: "project-b",
      revision: 2,
    });
    const result = applyTaskEventToList([visible], 1, makeEvent(moved, 2, "task.moved"));
    expect(result.needsRefresh).toBe(true);
    // Keep the prior snapshot until the query reload decides membership.
    expect(result.tasks).toEqual([visible]);
  });

  it("refreshes title changes because they can alter free-text query membership", () => {
    const visible = makeTask({ id: "a", title: "Old", revision: 1 });
    const renamed = makeTask({ id: "a", title: "New", revision: 2 });
    const result = applyTaskEventToList([visible], 1, makeEvent(renamed, 2, "task.updated"));
    expect(result.needsRefresh).toBe(true);
    expect(result.tasks).toEqual([visible]);
  });

  it("still patches display-only updates for a visible task without refreshing", () => {
    const visible = makeTask({ id: "a", title: "Tracked", actual_minutes: null, revision: 1 });
    const tracked = makeTask({ id: "a", title: "Tracked", actual_minutes: 25, revision: 2 });
    const result = applyTaskEventToList([visible], 1, makeEvent(tracked, 2, "task.updated"));
    expect(result.needsRefresh).toBe(false);
    expect(result.tasks[0]?.actual_minutes).toBe(25);
    expect(result.revision).toBe(2);
  });
});
