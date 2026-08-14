import { describe, expect, it } from "vitest";
import type { CommittedEventDto, TaskDto } from "../api/client";
import { detailRefreshFromEvent } from "./detailRefresh";

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Sample",
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision: 2,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:01:00Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CommittedEventDto> = {}): CommittedEventDto {
  return {
    revision: 2,
    operation_id: "op-1",
    event_type: "task.updated",
    occurred_at: "2026-07-23T10:01:00Z",
    affected: { task_ids: [] },
    resync: { tasks: false, catalog: false, settings: false },
    ...overrides,
  };
}

describe("detailRefreshFromEvent (P2-FE-001)", () => {
  it("ignores catalog-only events so detail is not refetched", () => {
    const action = detailRefreshFromEvent(
      "11111111-1111-4111-8111-111111111111",
      makeEvent({
        event_type: "project.updated",
        affected: { project_ids: ["p1"] },
        resync: { tasks: false, catalog: false, settings: false },
      }),
    );
    expect(action).toEqual({ kind: "none" });
  });

  it("ignores unrelated task events", () => {
    const action = detailRefreshFromEvent(
      "11111111-1111-4111-8111-111111111111",
      makeEvent({
        event_type: "task.updated",
        affected: { task_ids: ["22222222-2222-4222-8222-222222222222"] },
        snapshot: {
          resource_type: "task",
          task: makeTask({ id: "22222222-2222-4222-8222-222222222222" }),
        },
      }),
    );
    expect(action).toEqual({ kind: "none" });
  });

  it("applies a same-task snapshot without a network refetch", () => {
    const task = makeTask({ title: "Remote title" });
    const action = detailRefreshFromEvent(
      task.id,
      makeEvent({
        affected: { task_ids: [task.id] },
        snapshot: { resource_type: "task", task },
      }),
    );
    expect(action).toEqual({ kind: "snapshot", task });
  });

  it("refetches when the selected task is affected without a snapshot", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const action = detailRefreshFromEvent(
      id,
      makeEvent({
        event_type: "task.bulk",
        affected: { task_ids: [id, "22222222-2222-4222-8222-222222222222"] },
        resync: { tasks: true, catalog: false, settings: false },
      }),
    );
    expect(action).toEqual({ kind: "refetch" });
  });

  it("closes detail when the selected task is deleted", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const action = detailRefreshFromEvent(
      id,
      makeEvent({
        event_type: "task.deleted",
        affected: { task_ids: [id] },
      }),
    );
    expect(action).toEqual({ kind: "close" });
  });
});
