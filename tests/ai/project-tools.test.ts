import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerProjectCrudTools } from "../../src/ai/tools/builtin/project-crud.js";
import { registerTaskCrudTools } from "../../src/ai/tools/builtin/task-crud.js";
import { registerQueryTasksTool } from "../../src/ai/tools/builtin/query-tasks.js";
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

// ── Project CRUD tools ────────────────────────────────────────────────────────

describe("Project CRUD tools", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerProjectCrudTools(registry);
    const services = createTestServices();
    ctx = { taskService: services.taskService, projectService: services.projectService };
  });

  // ── create_project ──────────────────────────────────────────────────────

  it("creates a project with default color", async () => {
    const result = await exec(registry, "create_project", { name: "Work" }, ctx);
    expect(result.success).toBe(true);
    expect(result.project.name).toBe("Work");
    expect(result.project.color).toBe("#3b82f6");
    expect(result.project.id).toBeDefined();
    expect(result.project.archived).toBe(false);
  });

  it("creates a project with custom color", async () => {
    const result = await exec(
      registry,
      "create_project",
      { name: "Personal", color: "#22c55e" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.project.color).toBe("#22c55e");
  });

  // ── list_projects ───────────────────────────────────────────────────────

  it("lists empty projects", async () => {
    const result = await exec(registry, "list_projects", {}, ctx);
    expect(result.count).toBe(0);
    expect(result.projects).toEqual([]);
  });

  it("lists projects excluding archived by default", async () => {
    await exec(registry, "create_project", { name: "Active" }, ctx);
    const created = await exec(registry, "create_project", { name: "Old" }, ctx);
    await exec(registry, "update_project", { projectId: created.project.id, archived: true }, ctx);

    const result = await exec(registry, "list_projects", {}, ctx);
    expect(result.count).toBe(1);
    expect(result.projects[0].name).toBe("Active");
  });

  it("lists projects including archived when requested", async () => {
    await exec(registry, "create_project", { name: "Active" }, ctx);
    const created = await exec(registry, "create_project", { name: "Old" }, ctx);
    await exec(registry, "update_project", { projectId: created.project.id, archived: true }, ctx);

    const result = await exec(registry, "list_projects", { includeArchived: true }, ctx);
    expect(result.count).toBe(2);
  });

  // ── get_project ─────────────────────────────────────────────────────────

  it("gets a project by ID", async () => {
    const created = await exec(registry, "create_project", { name: "Lookup" }, ctx);

    const result = await exec(registry, "get_project", { projectId: created.project.id }, ctx);
    expect(result.project.name).toBe("Lookup");
    expect(result.project.createdAt).toBeDefined();
  });

  it("gets a project by name", async () => {
    await exec(registry, "create_project", { name: "ByName" }, ctx);

    const result = await exec(registry, "get_project", { name: "ByName" }, ctx);
    expect(result.project.name).toBe("ByName");
    expect(result.project.id).toBeDefined();
  });

  it("returns error for non-existent project", async () => {
    const result = await exec(registry, "get_project", { projectId: "nonexistent" }, ctx);
    expect(result.error).toBe("Project not found");
  });

  it("returns error when neither projectId nor name given", async () => {
    const result = await exec(registry, "get_project", {}, ctx);
    expect(result.error).toBe("Provide either projectId or name");
  });

  // ── update_project ──────────────────────────────────────────────────────

  it("updates project name", async () => {
    const created = await exec(registry, "create_project", { name: "Old" }, ctx);

    const result = await exec(
      registry,
      "update_project",
      { projectId: created.project.id, name: "New" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.project.name).toBe("New");
  });

  it("updates project color", async () => {
    const created = await exec(registry, "create_project", { name: "Colorful" }, ctx);

    const result = await exec(
      registry,
      "update_project",
      { projectId: created.project.id, color: "#ef4444" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.project.color).toBe("#ef4444");
  });

  it("archives a project via update", async () => {
    const created = await exec(registry, "create_project", { name: "Archive Me" }, ctx);

    const result = await exec(
      registry,
      "update_project",
      { projectId: created.project.id, archived: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.project.archived).toBe(true);
  });

  it("returns error when updating non-existent project", async () => {
    const result = await exec(
      registry,
      "update_project",
      { projectId: "nonexistent", name: "Nope" },
      ctx,
    );
    expect(result.error).toBe("Project not found");
  });

  // ── delete_project ──────────────────────────────────────────────────────

  it("deletes a project", async () => {
    const created = await exec(registry, "create_project", { name: "Doomed" }, ctx);

    const result = await exec(registry, "delete_project", { projectId: created.project.id }, ctx);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);

    // Verify it's gone
    const list = await exec(registry, "list_projects", {}, ctx);
    expect(list.count).toBe(0);
  });

  it("returns deleted=false for non-existent project", async () => {
    const result = await exec(registry, "delete_project", { projectId: "nonexistent" }, ctx);
    expect(result.deleted).toBe(false);
  });
});

// ── Cross-tool integration (project + task) ─────────────────────────────────

describe("Cross-tool integration (project + task)", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerProjectCrudTools(registry);
    registerTaskCrudTools(registry);
    registerQueryTasksTool(registry);
    const services = createTestServices();
    ctx = { taskService: services.taskService, projectService: services.projectService };
  });

  it("creates a project then assigns a task to it", async () => {
    const project = await exec(registry, "create_project", { name: "Sprint 25" }, ctx);

    const task = await exec(
      registry,
      "create_task",
      { title: "Implement feature", projectId: project.project.id },
      ctx,
    );
    expect(task.success).toBe(true);

    // Query tasks and verify the project assignment
    const tasks = await ctx.taskService.list();
    const created = tasks.find((t) => t.title === "Implement feature");
    expect(created).toBeDefined();
    expect(created!.projectId).toBe(project.project.id);
  });

  it("deleting a project nullifies task projectId", async () => {
    const project = await exec(registry, "create_project", { name: "Temporary" }, ctx);
    const task = await exec(
      registry,
      "create_task",
      { title: "Linked task", projectId: project.project.id },
      ctx,
    );

    await exec(registry, "delete_project", { projectId: project.project.id }, ctx);

    const fetched = await ctx.taskService.get(task.task.id);
    expect(fetched!.projectId).toBeNull();
  });

  it("lists projects and uses ID to create a task", async () => {
    await exec(registry, "create_project", { name: "Alpha" }, ctx);
    await exec(registry, "create_project", { name: "Beta" }, ctx);

    const list = await exec(registry, "list_projects", {}, ctx);
    expect(list.count).toBe(2);

    const betaProject = list.projects.find((p: { name: string }) => p.name === "Beta");
    const task = await exec(
      registry,
      "create_task",
      { title: "Beta task", projectId: betaProject.id },
      ctx,
    );
    expect(task.success).toBe(true);

    const tasks = await ctx.taskService.list();
    expect(tasks[0].projectId).toBe(betaProject.id);
  });

  it("gets a project by name and verifies ID resolution", async () => {
    const created = await exec(registry, "create_project", { name: "Resolve Me" }, ctx);

    const byName = await exec(registry, "get_project", { name: "Resolve Me" }, ctx);
    expect(byName.project.id).toBe(created.project.id);
    expect(byName.project.name).toBe("Resolve Me");
  });
});
