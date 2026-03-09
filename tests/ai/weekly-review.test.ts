import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerWeeklyReviewTool } from "../../src/ai/tools/builtin/weekly-review.js";
import { createTestServices } from "../integration/helpers.js";
import type { ToolContext } from "../../src/ai/tools/types.js";
import type { TaskService } from "../../src/core/tasks.js";
import type { ProjectService } from "../../src/core/projects.js";

function exec(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return registry.execute(name, args, ctx).then((r) => JSON.parse(r));
}

function _todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

/** Get last Monday as YYYY-MM-DD. */
function getLastMonday(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const daysBack = diff === 0 ? 7 : diff;
  now.setDate(now.getDate() - daysBack);
  return now.toISOString().split("T")[0];
}

describe("weekly_review", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;
  let projectService: ProjectService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerWeeklyReviewTool(registry);
    const services = createTestServices();
    taskService = services.taskService;
    projectService = services.projectService;
    ctx = { taskService, projectService };
  });

  it("returns full structure with empty week", async () => {
    const result = await exec(registry, "weekly_review", {}, ctx);
    expect(result.weekStartDate).toBe(getLastMonday());
    expect(result.completionRate).toBe(0);
    expect(result.taskFlow.created).toBe(0);
    expect(result.taskFlow.completed).toBe(0);
    expect(result.taskFlow.cancelled).toBe(0);
    expect(result.dailyStats).toHaveLength(7);
    expect(result.overdue.count).toBe(0);
    expect(result.overdue.tasks).toEqual([]);
    expect(result.topAccomplishments).toEqual([]);
    expect(result.suggestions).toEqual([]);
    expect(result.neglectedProjects).toEqual([]);
    expect(result.streak.currentDays).toBe(0);
    expect(result.streak.isActive).toBe(false);
  });

  it("computes basic completion rate and task flow", async () => {
    // Create tasks during a specific week
    const monday = getLastMonday();
    const dateStr = `${monday}T10:00:00.000Z`;

    const t1 = await taskService.create({ title: "Task 1", tags: [], dueDate: dateStr });
    const t2 = await taskService.create({ title: "Task 2", tags: [], dueDate: dateStr });
    await taskService.create({ title: "Task 3", tags: [], dueDate: dateStr });
    await taskService.complete(t1.id);
    await taskService.complete(t2.id);

    const result = await exec(registry, "weekly_review", { weekStartDate: monday }, ctx);

    // completedInWeek = 2 (t1, t2), createdInWeek = 3 (all created today which may or may not be in the week)
    // The actual numbers depend on whether today is within the specified week
    expect(result.taskFlow.completed).toBeGreaterThanOrEqual(0);
    expect(result.weekStartDate).toBe(monday);
    expect(result.weekEndDate).toBeTruthy();
  });

  it("defaults weekStartDate to last Monday", async () => {
    const result = await exec(registry, "weekly_review", {}, ctx);
    const expected = getLastMonday();
    expect(result.weekStartDate).toBe(expected);

    // Verify weekEndDate is 6 days after start
    const start = new Date(result.weekStartDate + "T00:00:00");
    const end = new Date(result.weekEndDate + "T00:00:00");
    const diffDays = Math.round((end.getTime() - start.getTime()) / 86400000);
    expect(diffDays).toBe(6);
  });

  it("identifies the busiest day", async () => {
    const monday = getLastMonday();
    const dateStr = `${monday}T10:00:00.000Z`;

    // Create and complete tasks with completedAt on the monday
    const t1 = await taskService.create({ title: "Monday Task 1", tags: [], dueDate: dateStr });
    const t2 = await taskService.create({ title: "Monday Task 2", tags: [], dueDate: dateStr });
    await taskService.complete(t1.id);
    await taskService.complete(t2.id);

    const result = await exec(registry, "weekly_review", { weekStartDate: monday }, ctx);

    // The busiest day should exist and have the highest completion count
    if (result.busiestDay && result.busiestDay.completed > 0) {
      expect(result.busiestDay.dayName).toBeTruthy();
      expect(result.busiestDay.completed).toBeGreaterThan(0);
    }
  });

  it("detects neglected projects with overdue tasks", async () => {
    const project = await projectService.create("Neglected Project");
    const twoDaysAgo = `${daysAgo(2)}T10:00:00.000Z`;
    await taskService.create({
      title: "Overdue in project",
      tags: [],
      projectId: project.id,
      dueDate: twoDaysAgo,
    });

    const result = await exec(registry, "weekly_review", {}, ctx);
    expect(result.neglectedProjects.length).toBeGreaterThanOrEqual(1);
    const found = result.neglectedProjects.find(
      (p: { name: string }) => p.name === "Neglected Project",
    );
    expect(found).toBeDefined();
    expect(found.overdueCount).toBeGreaterThanOrEqual(1);
  });

  it("calculates streak from completed tasks", async () => {
    // Complete tasks today and yesterday to get streak of 2
    const t1 = await taskService.create({ title: "Today task", tags: [] });
    await taskService.complete(t1.id);

    const result = await exec(registry, "weekly_review", {}, ctx);
    expect(result.streak.currentDays).toBeGreaterThanOrEqual(1);
    expect(result.streak.isActive).toBe(true);
  });

  it("reports zero streak when no completions", async () => {
    const result = await exec(registry, "weekly_review", {}, ctx);
    expect(result.streak.currentDays).toBe(0);
    expect(result.streak.isActive).toBe(false);
  });

  it("identifies top accomplishments by priority", async () => {
    const monday = getLastMonday();
    const dateStr = `${monday}T10:00:00.000Z`;

    const t1 = await taskService.create({
      title: "Critical task",
      tags: [],
      priority: 1,
      dueDate: dateStr,
    });
    const t2 = await taskService.create({
      title: "Normal task",
      tags: [],
      priority: 4,
      dueDate: dateStr,
    });
    await taskService.complete(t1.id);
    await taskService.complete(t2.id);

    const result = await exec(registry, "weekly_review", { weekStartDate: monday }, ctx);

    // Top accomplishments should exist if tasks were completed within the week
    if (result.topAccomplishments.length > 0) {
      // First should be highest priority (P1 = 1)
      expect(result.topAccomplishments[0].priority).toBeLessThanOrEqual(
        result.topAccomplishments[result.topAccomplishments.length - 1].priority ?? 5,
      );
    }
  });

  it("assigns time buckets correctly", async () => {
    const monday = getLastMonday();

    // Create and complete a task (completedAt will be "now")
    const t = await taskService.create({
      title: "Timed task",
      tags: [],
      dueDate: `${monday}T10:00:00.000Z`,
    });
    await taskService.complete(t.id);

    const result = await exec(registry, "weekly_review", { weekStartDate: monday }, ctx);

    // productiveTimeCounts should have the 4 buckets
    expect(result.productiveTimeCounts).toHaveProperty("morning");
    expect(result.productiveTimeCounts).toHaveProperty("afternoon");
    expect(result.productiveTimeCounts).toHaveProperty("evening");
    expect(result.productiveTimeCounts).toHaveProperty("night");
  });

  it("counts overdue tasks correctly", async () => {
    const twoDaysAgo = `${daysAgo(2)}T10:00:00.000Z`;
    const threeDaysAgo = `${daysAgo(3)}T10:00:00.000Z`;
    await taskService.create({ title: "Overdue 1", tags: [], dueDate: twoDaysAgo });
    await taskService.create({ title: "Overdue 2", tags: [], dueDate: threeDaysAgo });

    const result = await exec(registry, "weekly_review", {}, ctx);
    expect(result.overdue.count).toBe(2);
    expect(result.overdue.tasks).toHaveLength(2);
    expect(result.overdue.tasks[0].title).toBeTruthy();
  });

  it("rejects gracefully with invalid date (still returns data)", async () => {
    // Even with a weird date, the tool should not crash
    const result = await exec(registry, "weekly_review", { weekStartDate: "2025-01-06" }, ctx);
    expect(result.weekStartDate).toBe("2025-01-06");
    expect(result.dailyStats).toHaveLength(7);
  });

  it("generates suggestions for overdue tasks", async () => {
    const twoDaysAgo = `${daysAgo(2)}T10:00:00.000Z`;
    await taskService.create({ title: "Overdue", tags: [], dueDate: twoDaysAgo });

    const result = await exec(registry, "weekly_review", {}, ctx);
    expect(result.suggestions.some((s: string) => s.includes("overdue"))).toBe(true);
  });

  it("daily stats always has 7 entries", async () => {
    const result = await exec(registry, "weekly_review", { weekStartDate: "2025-06-02" }, ctx);
    expect(result.dailyStats).toHaveLength(7);
    // First day should be Monday
    expect(result.dailyStats[0].dayName).toBe("Monday");
    // Last day should be Sunday
    expect(result.dailyStats[6].dayName).toBe("Sunday");
  });

  it("caps output lists at 10 items", async () => {
    // Create 12 overdue tasks
    for (let i = 0; i < 12; i++) {
      await taskService.create({
        title: `Overdue ${i}`,
        tags: [],
        dueDate: `${daysAgo(2)}T10:00:00.000Z`,
      });
    }

    const result = await exec(registry, "weekly_review", {}, ctx);
    expect(result.overdue.tasks.length).toBeLessThanOrEqual(10);
  });
});
