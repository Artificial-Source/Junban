import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerTagCrudTools } from "../../src/ai/tools/builtin/tag-crud.js";
import { registerTaskCrudTools } from "../../src/ai/tools/builtin/task-crud.js";
import { createTestServices } from "../integration/helpers.js";
import type { ToolContext } from "../../src/ai/tools/types.js";

function exec(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return registry.execute(name, args, ctx).then((r) => JSON.parse(r));
}

describe("Tag CRUD tools", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerTagCrudTools(registry);
    registerTaskCrudTools(registry);
    const services = createTestServices();
    ctx = {
      taskService: services.taskService,
      projectService: services.projectService,
      tagService: services.tagService,
    };
  });

  // ── list_tags ──

  it("returns empty list when no tags exist", async () => {
    const result = await exec(registry, "list_tags", {}, ctx);
    expect(result.count).toBe(0);
    expect(result.tags).toEqual([]);
  });

  it("lists tags after tasks are created with tags", async () => {
    await exec(registry, "create_task", { title: "Tagged task", tags: ["work", "urgent"] }, ctx);
    const result = await exec(registry, "list_tags", {}, ctx);
    expect(result.count).toBe(2);
    const names = result.tags.map((t: { name: string }) => t.name);
    expect(names).toContain("work");
    expect(names).toContain("urgent");
  });

  // ── add_tags_to_task ──

  it("adds tags to a task without removing existing ones", async () => {
    const created = await exec(
      registry,
      "create_task",
      { title: "My task", tags: ["existing"] },
      ctx,
    );
    const taskId = created.task.id;

    const result = await exec(registry, "add_tags_to_task", { taskId, tags: ["new-tag"] }, ctx);
    expect(result.success).toBe(true);
    expect(result.task.tags).toContain("existing");
    expect(result.task.tags).toContain("new-tag");
    expect(result.task.tags).toHaveLength(2);
  });

  it("does not duplicate existing tags when adding", async () => {
    const created = await exec(registry, "create_task", { title: "My task", tags: ["work"] }, ctx);
    const taskId = created.task.id;

    const result = await exec(
      registry,
      "add_tags_to_task",
      { taskId, tags: ["work", "play"] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.task.tags).toHaveLength(2);
    expect(result.task.tags).toContain("work");
    expect(result.task.tags).toContain("play");
  });

  it("returns error for non-existent task when adding tags", async () => {
    const result = await exec(
      registry,
      "add_tags_to_task",
      { taskId: "nonexistent", tags: ["tag"] },
      ctx,
    );
    expect(result.error).toBeDefined();
  });

  // ── remove_tags_from_task ──

  it("removes specific tags from a task", async () => {
    const created = await exec(
      registry,
      "create_task",
      { title: "My task", tags: ["a", "b", "c"] },
      ctx,
    );
    const taskId = created.task.id;

    const result = await exec(registry, "remove_tags_from_task", { taskId, tags: ["b"] }, ctx);
    expect(result.success).toBe(true);
    expect(result.task.tags).toContain("a");
    expect(result.task.tags).toContain("c");
    expect(result.task.tags).not.toContain("b");
    expect(result.task.tags).toHaveLength(2);
  });

  it("is case-insensitive when removing tags", async () => {
    const created = await exec(registry, "create_task", { title: "My task", tags: ["Work"] }, ctx);
    const taskId = created.task.id;

    const result = await exec(registry, "remove_tags_from_task", { taskId, tags: ["work"] }, ctx);
    expect(result.success).toBe(true);
    expect(result.task.tags).toHaveLength(0);
  });

  it("returns error for non-existent task when removing tags", async () => {
    const result = await exec(
      registry,
      "remove_tags_from_task",
      { taskId: "nonexistent", tags: ["tag"] },
      ctx,
    );
    expect(result.error).toBeDefined();
  });

  it("handles removing a tag that does not exist on the task", async () => {
    const created = await exec(registry, "create_task", { title: "My task", tags: ["keep"] }, ctx);
    const taskId = created.task.id;

    const result = await exec(
      registry,
      "remove_tags_from_task",
      { taskId, tags: ["nonexistent"] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.task.tags).toContain("keep");
    expect(result.task.tags).toHaveLength(1);
  });
});
