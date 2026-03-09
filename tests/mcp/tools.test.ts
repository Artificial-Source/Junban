import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMcpTestEnv } from "./helpers.js";

let env: Awaited<ReturnType<typeof createMcpTestEnv>>;

describe("MCP Tools", () => {
  beforeEach(async () => {
    env = await createMcpTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("lists all registered tools", async () => {
    const result = await env.client.listTools();
    expect(result.tools.length).toBeGreaterThanOrEqual(25);

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("create_task");
    expect(names).toContain("update_task");
    expect(names).toContain("complete_task");
    expect(names).toContain("delete_task");
    expect(names).toContain("query_tasks");
    expect(names).toContain("create_project");
    expect(names).toContain("list_projects");
    expect(names).toContain("analyze_workload");
    expect(names).toContain("plan_my_day");
    expect(names).toContain("daily_review");
  });

  it("creates a task via MCP tool call", async () => {
    const result = await env.client.callTool({
      name: "create_task",
      arguments: { title: "Buy groceries", priority: 2 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);

    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.title).toBe("Buy groceries");
    expect(parsed.task.priority).toBe(2);
  });

  it("completes a task via MCP tool call", async () => {
    // Create first
    const createResult = await env.client.callTool({
      name: "create_task",
      arguments: { title: "Do laundry" },
    });
    const created = JSON.parse((createResult.content[0] as { type: "text"; text: string }).text);

    // Complete
    const completeResult = await env.client.callTool({
      name: "complete_task",
      arguments: { taskId: created.task.id },
    });

    expect(completeResult.isError).toBeFalsy();
    const completed = JSON.parse(
      (completeResult.content[0] as { type: "text"; text: string }).text,
    );
    expect(completed.task.status).toBe("completed");
  });

  it("returns error for unknown tool", async () => {
    const result = await env.client.callTool({
      name: "nonexistent_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("not found");
  });

  it("queries tasks via MCP", async () => {
    // Create a few tasks
    await env.client.callTool({
      name: "create_task",
      arguments: { title: "Task A", priority: 1 },
    });
    await env.client.callTool({
      name: "create_task",
      arguments: { title: "Task B", priority: 3 },
    });

    const result = await env.client.callTool({
      name: "query_tasks",
      arguments: { status: "pending" },
    });

    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
    expect(parsed.count).toBe(2);
  });

  it("creates and lists projects via MCP", async () => {
    await env.client.callTool({
      name: "create_project",
      arguments: { name: "Work", color: "#ff0000" },
    });

    const listResult = await env.client.callTool({
      name: "list_projects",
      arguments: {},
    });

    const parsed = JSON.parse((listResult.content[0] as { type: "text"; text: string }).text);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].name).toBe("Work");
  });

  it("each tool has a description and inputSchema", async () => {
    const result = await env.client.listTools();
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});
