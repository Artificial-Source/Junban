import { describe, expect, it } from "vitest";
import type { components, operations, paths } from "./generated";

/**
 * Lightweight drift smoke checks for the checked-in OpenAPI TypeScript output.
 * Full byte-for-byte regeneration drift is enforced by `pnpm contract:check`.
 */
describe("OpenAPI TypeScript contract surface", () => {
  it("exposes every Phase 2 operation family used by the API facade", () => {
    const operationNames: (keyof operations)[] = [
      "list_tasks",
      "create_task",
      "patch_task",
      "delete_task",
      "complete_task",
      "uncomplete_task",
      "cancel_task",
      "reopen_task",
      "move_task",
      "reorder_tasks",
      "bulk_tasks",
      "get_catalog",
      "create_project",
      "create_section",
      "create_tag",
      "create_template",
      "apply_template",
      "create_saved_filter",
      "create_comment",
      "add_relation",
      "list_task_activity",
      "parse_quick_entry",
      "parse_filter",
      "parse_text_import",
      "undo_operation",
      "events",
      "health",
      "get_profile",
    ];

    // Type-level presence is enforced by the array annotation; runtime checks paths.
    const pathKeys = Object.keys({
      "/api/v1/tasks": true,
      "/api/v1/tasks/actions": true,
      "/api/v1/catalog": true,
      "/api/v1/events": true,
      "/api/v1/operations/{source_operation_id}/undo": true,
    } satisfies Partial<Record<keyof paths, true>>);

    expect(pathKeys.length).toBeGreaterThan(0);
    expect(operationNames).toContain("bulk_tasks");

    type CreateTask = components["schemas"]["CreateTaskRequest"];
    type Bulk = components["schemas"]["BulkTasksRequest"];
    type Event = components["schemas"]["CommittedEventDto"];

    const createProbe: CreateTask = { title: "x" };
    const bulkProbe: Bulk = {
      task_ids: ["11111111-1111-4111-8111-111111111111"],
      action: { type: "complete" },
    };
    const eventProbe: Event = {
      revision: 1,
      operation_id: "11111111-1111-4111-8111-111111111111",
      event_type: "task.created",
      occurred_at: "2026-07-28T00:00:00Z",
      affected: {},
      resync: { tasks: false, catalog: false, settings: false },
    };

    expect(createProbe).not.toHaveProperty("id");
    expect(bulkProbe.action).toEqual({ type: "complete" });
    expect(eventProbe.resync.tasks).toBe(false);
  });

  it("types create requests without a primary id field", () => {
    type CreateTask = components["schemas"]["CreateTaskRequest"];
    type CreateProject = components["schemas"]["CreateProjectRequest"];
    type CreateComment = components["schemas"]["CreateCommentRequest"];

    // Compile-time: assigning `id` must be rejected. The next lines are type assertions only.
    const task: CreateTask = { title: "t" };
    const project: CreateProject = { name: "p", color: "#000" };
    const comment: CreateComment = { content: "c" };

    type TaskHasId = "id" extends keyof CreateTask ? true : false;
    type ProjectHasId = "id" extends keyof CreateProject ? true : false;
    type CommentHasId = "id" extends keyof CreateComment ? true : false;

    const taskHasId: TaskHasId = false;
    const projectHasId: ProjectHasId = false;
    const commentHasId: CommentHasId = false;

    expect(taskHasId || projectHasId || commentHasId).toBe(false);
    expect(task.title).toBe("t");
    expect(project.name).toBe("p");
    expect(comment.content).toBe("c");
  });
});
