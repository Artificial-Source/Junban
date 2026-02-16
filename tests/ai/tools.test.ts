import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerTaskCrudTools } from "../../src/ai/tools/builtin/task-crud.js";
import { registerQueryTasksTool } from "../../src/ai/tools/builtin/query-tasks.js";
import { createDefaultToolRegistry } from "../../src/ai/provider.js";
import { createTestServices } from "../integration/helpers.js";

describe("ToolRegistry", () => {
  it("returns all expected tools from default registry", () => {
    const registry = createDefaultToolRegistry();
    const defs = registry.getDefinitions();
    const names = defs.map((t) => t.name);
    expect(names).toContain("create_task");
    expect(names).toContain("query_tasks");
    expect(names).toContain("complete_task");
    expect(names).toContain("update_task");
    expect(names).toContain("delete_task");
    expect(defs).toHaveLength(10);
  });

  it("each tool has name, description, and parameters", () => {
    const registry = createDefaultToolRegistry();
    const defs = registry.getDefinitions();
    for (const tool of defs) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe("object");
    }
  });

  it("registers and unregisters a tool", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "my_tool", description: "Test", parameters: { type: "object" } },
      async () => "ok",
    );
    expect(registry.has("my_tool")).toBe(true);
    expect(registry.size).toBe(1);

    registry.unregister("my_tool");
    expect(registry.has("my_tool")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("unregisterBySource removes only matching tools", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "builtin_tool", description: "Built-in", parameters: { type: "object" } },
      async () => "ok",
      "builtin",
    );
    registry.register(
      { name: "plugin_tool", description: "Plugin", parameters: { type: "object" } },
      async () => "ok",
      "my-plugin",
    );

    registry.unregisterBySource("my-plugin");
    expect(registry.has("builtin_tool")).toBe(true);
    expect(registry.has("plugin_tool")).toBe(false);
  });

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "dup", description: "Test", parameters: { type: "object" } },
      async () => "ok",
    );
    expect(() =>
      registry.register(
        { name: "dup", description: "Test2", parameters: { type: "object" } },
        async () => "ok2",
      ),
    ).toThrow("already registered");
  });

  it("throws for unknown tool on execute", async () => {
    const registry = new ToolRegistry();
    const { taskService, projectService } = createTestServices();
    await expect(
      registry.execute("unknown_tool", {}, { taskService, projectService }),
    ).rejects.toThrow("Unknown tool: unknown_tool");
  });
});

describe("Built-in tool execution", () => {
  function createRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registerTaskCrudTools(registry);
    registerQueryTasksTool(registry);
    return registry;
  }

  it("create_task creates a task", async () => {
    const { taskService, projectService } = createTestServices();
    const registry = createRegistry();
    const result = await registry.execute(
      "create_task",
      { title: "Test task" },
      { taskService, projectService },
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.task.title).toBe("Test task");
    expect(parsed.task.status).toBe("pending");
  });

  it("query_tasks returns tasks", async () => {
    const { taskService, projectService } = createTestServices();
    await taskService.create({ title: "Task A", tags: [] });
    await taskService.create({ title: "Task B", tags: [] });

    const registry = createRegistry();
    const result = await registry.execute("query_tasks", {}, { taskService, projectService });
    const parsed = JSON.parse(result);
    expect(parsed.count).toBe(2);
    expect(parsed.tasks).toHaveLength(2);
  });

  it("query_tasks filters by status", async () => {
    const { taskService, projectService } = createTestServices();
    const task = await taskService.create({ title: "Task A", tags: [] });
    await taskService.create({ title: "Task B", tags: [] });
    await taskService.complete(task.id);

    const registry = createRegistry();
    const result = await registry.execute(
      "query_tasks",
      { status: "pending" },
      { taskService, projectService },
    );
    const parsed = JSON.parse(result);
    expect(parsed.count).toBe(1);
    expect(parsed.tasks[0].title).toBe("Task B");
  });

  it("complete_task completes a task", async () => {
    const { taskService, projectService } = createTestServices();
    const task = await taskService.create({ title: "Do thing", tags: [] });

    const registry = createRegistry();
    const result = await registry.execute(
      "complete_task",
      { taskId: task.id },
      { taskService, projectService },
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe("completed");
  });

  it("update_task updates a task", async () => {
    const { taskService, projectService } = createTestServices();
    const task = await taskService.create({ title: "Old title", tags: [] });

    const registry = createRegistry();
    const result = await registry.execute(
      "update_task",
      { taskId: task.id, title: "New title" },
      { taskService, projectService },
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.task.title).toBe("New title");
  });

  it("delete_task deletes a task", async () => {
    const { taskService, projectService } = createTestServices();
    const task = await taskService.create({ title: "Delete me", tags: [] });

    const registry = createRegistry();
    const result = await registry.execute(
      "delete_task",
      { taskId: task.id },
      { taskService, projectService },
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.deleted).toBe(true);

    // Verify it's gone
    const listResult = await registry.execute("query_tasks", {}, { taskService, projectService });
    expect(JSON.parse(listResult).count).toBe(0);
  });

  it("create_task supports recurrence and remindAt", async () => {
    const { taskService, projectService } = createTestServices();
    const registry = createRegistry();
    const result = await registry.execute(
      "create_task",
      {
        title: "Daily standup",
        recurrence: "daily",
        remindAt: "2024-06-01T08:30:00.000Z",
        dueDate: "2024-06-01T09:00:00.000Z",
      },
      { taskService, projectService },
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.task.title).toBe("Daily standup");

    // Verify the task was created with recurrence
    const tasks = await taskService.list();
    const created = tasks.find((t) => t.title === "Daily standup");
    expect(created).toBeDefined();
    expect(created!.recurrence).toBe("daily");
    expect(created!.remindAt).toBe("2024-06-01T08:30:00.000Z");
  });

  it("query_tasks includes recurrence and remindAt in response", async () => {
    const { taskService, projectService } = createTestServices();
    await taskService.create({
      title: "Weekly review",
      recurrence: "weekly",
      remindAt: "2024-06-01T10:00:00.000Z",
    });

    const registry = createRegistry();
    const result = await registry.execute("query_tasks", {}, { taskService, projectService });
    const parsed = JSON.parse(result);
    expect(parsed.tasks[0].recurrence).toBe("weekly");
    expect(parsed.tasks[0].remindAt).toBe("2024-06-01T10:00:00.000Z");
  });
});
