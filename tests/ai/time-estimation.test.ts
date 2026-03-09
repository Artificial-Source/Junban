import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerTimeEstimationTools } from "../../src/ai/tools/builtin/time-estimation.js";
import { createTestServices } from "../integration/helpers.js";
import type { ToolContext } from "../../src/ai/tools/types.js";

function createToolContext() {
  const { taskService, projectService, tagService, storage } = createTestServices();
  const ctx: ToolContext = { taskService, projectService, tagService, storage };
  return { ctx, taskService, storage };
}

describe("time-estimation tools", () => {
  describe("estimate_task_duration", () => {
    it("registers the tool", () => {
      const registry = new ToolRegistry();
      registerTimeEstimationTools(registry);
      expect(registry.has("estimate_task_duration")).toBe(true);
    });

    it("returns no suggestion when no completed tasks with time", async () => {
      const registry = new ToolRegistry();
      registerTimeEstimationTools(registry);
      const { ctx, taskService } = createToolContext();

      const task = await taskService.create({ title: "New task", dueTime: false });
      const result = JSON.parse(
        await registry.execute("estimate_task_duration", { taskId: task.id }, ctx),
      );
      expect(result.success).toBe(true);
      expect(result.suggestion).toBeNull();
    });

    it("suggests duration based on similar completed tasks", async () => {
      const registry = new ToolRegistry();
      registerTimeEstimationTools(registry);
      const { ctx, taskService } = createToolContext();

      // Create and complete tasks with time tracking
      const t1 = await taskService.create({
        title: "Review code changes",
        dueTime: false,
        tags: ["dev"],
      });
      await taskService.update(t1.id, { actualMinutes: 30 });
      await taskService.complete(t1.id);

      const t2 = await taskService.create({
        title: "Review pull request",
        dueTime: false,
        tags: ["dev"],
      });
      await taskService.update(t2.id, { actualMinutes: 45 });
      await taskService.complete(t2.id);

      // Create new task to estimate
      const newTask = await taskService.create({
        title: "Review new code",
        dueTime: false,
        tags: ["dev"],
      });

      const result = JSON.parse(
        await registry.execute("estimate_task_duration", { taskId: newTask.id }, ctx),
      );
      expect(result.success).toBe(true);
      expect(result.suggestion).toBeGreaterThan(0);
      expect(result.basedOn).toBeGreaterThan(0);
    });

    it("returns error for non-existent task", async () => {
      const registry = new ToolRegistry();
      registerTimeEstimationTools(registry);
      const { ctx } = createToolContext();

      const result = JSON.parse(
        await registry.execute("estimate_task_duration", { taskId: "nonexistent" }, ctx),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe("Task not found");
    });
  });

  describe("time_tracking_summary", () => {
    it("registers the tool", () => {
      const registry = new ToolRegistry();
      registerTimeEstimationTools(registry);
      expect(registry.has("time_tracking_summary")).toBe(true);
    });

    it("returns empty stats when no tracked tasks", async () => {
      const registry = new ToolRegistry();
      registerTimeEstimationTools(registry);
      const { ctx } = createToolContext();

      const result = JSON.parse(await registry.execute("time_tracking_summary", {}, ctx));
      expect(result.success).toBe(true);
      expect(result.totalTasks).toBe(0);
    });

    it("computes accuracy stats for tasks with both estimated and actual", async () => {
      const registry = new ToolRegistry();
      registerTimeEstimationTools(registry);
      const { ctx, taskService } = createToolContext();

      // Task 1: estimated 30, actual 30 (accurate)
      const t1 = await taskService.create({
        title: "Task 1",
        dueTime: false,
        estimatedMinutes: 30,
      });
      await taskService.update(t1.id, { actualMinutes: 30 });
      await taskService.complete(t1.id);

      // Task 2: estimated 60, actual 90 (underestimated)
      const t2 = await taskService.create({
        title: "Task 2",
        dueTime: false,
        estimatedMinutes: 60,
      });
      await taskService.update(t2.id, { actualMinutes: 90 });
      await taskService.complete(t2.id);

      const result = JSON.parse(await registry.execute("time_tracking_summary", {}, ctx));
      expect(result.success).toBe(true);
      expect(result.totalTasks).toBe(2);
      expect(result.totalEstimatedMinutes).toBe(90);
      expect(result.totalActualMinutes).toBe(120);
      expect(result.accurate).toBe(1);
      expect(result.underEstimated).toBe(1);
      expect(result.overEstimated).toBe(0);
    });
  });
});
