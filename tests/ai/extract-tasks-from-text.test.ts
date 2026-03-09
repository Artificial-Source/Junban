import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerExtractTasksFromTextTool } from "../../src/ai/tools/builtin/extract-tasks-from-text.js";
import { createTestServices } from "../integration/helpers.js";
import type { ToolContext } from "../../src/ai/tools/types.js";
import type { TaskService } from "../../src/core/tasks.js";

function exec(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return registry.execute(name, args, ctx).then((r) => JSON.parse(r));
}

describe("extract_tasks_from_text", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerExtractTasksFromTextTool(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("extracts tasks from bullet list (dry run)", async () => {
    const text = `Meeting notes:
- Review the Q4 report
- Send follow-up email to Sarah
- Schedule team standup for next week`;

    const result = await exec(registry, "extract_tasks_from_text", { text, dryRun: true }, ctx);

    expect(result.created).toBe(false);
    expect(result.count).toBeGreaterThan(0);
    expect(result.tasks.length).toBeGreaterThan(0);
    // Titles should start with capital letter
    for (const task of result.tasks) {
      expect(task.title.charAt(0)).toBe(task.title.charAt(0).toUpperCase());
    }
  });

  it("creates tasks when dryRun=false", async () => {
    const text = `- Review the PR
- Update documentation
- Fix the login bug`;

    const result = await exec(registry, "extract_tasks_from_text", { text, dryRun: false }, ctx);

    expect(result.created).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.createdTasks).toBeDefined();
    expect(result.createdTasks.length).toBe(result.count);

    // Verify tasks exist in storage
    for (const t of result.createdTasks) {
      const task = await taskService.get(t.id);
      expect(task).toBeDefined();
      expect(task!.title).toBe(t.title);
    }
  });

  it("assigns projectId to created tasks", async () => {
    const project = await ctx.projectService.create("Sprint 5");
    const text = `- Review design spec
- Implement feature`;

    const result = await exec(
      registry,
      "extract_tasks_from_text",
      { text, projectId: project.id, dryRun: false },
      ctx,
    );

    expect(result.created).toBe(true);
    for (const t of result.createdTasks) {
      const task = await taskService.get(t.id);
      expect(task).toBeDefined();
      expect(task!.projectId).toBe(project.id);
    }
  });

  it("handles empty text", async () => {
    const result = await exec(registry, "extract_tasks_from_text", { text: "", dryRun: true }, ctx);

    expect(result.error).toBe("No text provided");
    expect(result.tasks).toEqual([]);
    expect(result.created).toBe(false);
    expect(result.count).toBe(0);
  });

  it("handles text with no actionable items", async () => {
    const text = `The weather was nice today.
It was a great meeting.
Everyone seemed happy.`;

    const result = await exec(registry, "extract_tasks_from_text", { text, dryRun: true }, ctx);

    expect(result.tasks).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.message).toContain("No actionable tasks found");
  });

  it("extracts from numbered lists", async () => {
    const text = `Notes from the meeting:
1. Review the budget
2. Send the proposal
3. Update the timeline`;

    const result = await exec(registry, "extract_tasks_from_text", { text, dryRun: true }, ctx);

    expect(result.count).toBe(3);
    const titles = result.tasks.map((t: { title: string }) => t.title);
    expect(titles).toContain("Review the budget");
    expect(titles).toContain("Send the proposal");
    expect(titles).toContain("Update the timeline");
  });

  it("extracts from lines starting with action verbs", async () => {
    const text = `Review all code changes before merge
Send the report to the client
Deploy the staging environment`;

    const result = await exec(registry, "extract_tasks_from_text", { text, dryRun: true }, ctx);

    expect(result.count).toBe(3);
  });

  it("detects priority from urgency words", async () => {
    const text = `- Fix the critical production bug
- Update documentation whenever possible`;

    const result = await exec(registry, "extract_tasks_from_text", { text, dryRun: true }, ctx);

    expect(result.count).toBe(2);
    const criticalTask = result.tasks.find((t: { title: string }) =>
      t.title.toLowerCase().includes("critical"),
    );
    const lowTask = result.tasks.find((t: { title: string }) =>
      t.title.toLowerCase().includes("whenever"),
    );
    expect(criticalTask?.priority).toBe(1);
    expect(lowTask?.priority).toBe(4);
  });

  it("defaults dryRun to true when not specified", async () => {
    const text = `- Review the design`;

    const result = await exec(registry, "extract_tasks_from_text", { text }, ctx);

    expect(result.created).toBe(false);

    // Verify no tasks were created
    const allTasks = await taskService.list({});
    expect(allTasks).toHaveLength(0);
  });

  it("handles mixed format input", async () => {
    const text = `Meeting Notes - March 9

Discussion points were good.

TODO: Review the architecture document
- Send meeting summary to all attendees
* Check the build pipeline

Next meeting is on Friday.`;

    const result = await exec(registry, "extract_tasks_from_text", { text, dryRun: true }, ctx);

    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  it("returns projectId in preview tasks", async () => {
    const project = await ctx.projectService.create("My Project");
    const text = `- Review the spec`;

    const result = await exec(
      registry,
      "extract_tasks_from_text",
      { text, projectId: project.id, dryRun: true },
      ctx,
    );

    expect(result.tasks[0].projectId).toBe(project.id);
  });

  it("handles whitespace-only text", async () => {
    const result = await exec(registry, "extract_tasks_from_text", { text: "   \n  \n  " }, ctx);

    expect(result.error).toBe("No text provided");
  });
});
