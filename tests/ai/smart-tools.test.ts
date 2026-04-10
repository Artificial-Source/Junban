import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerAnalyzePatternsTool } from "../../src/ai/tools/builtin/analyze-patterns.js";
import {
  registerAnalyzeWorkloadTool,
  registerCheckOvercommitmentTool,
} from "../../src/ai/tools/builtin/analyze-workload.js";
import {
  registerSmartOrganizeTools,
  registerCheckDuplicatesTool,
} from "../../src/ai/tools/builtin/smart-organize.js";
import { registerEnergyRecommendationsTool } from "../../src/ai/tools/builtin/energy-recommendations.js";
import { createDefaultToolRegistry } from "../../src/ai/tool-registry.js";
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

// ── Default registry includes new tools ───────────────────────────────────────

describe("Default tool registry includes smart tools", () => {
  it("registers all tools", () => {
    const registry = createDefaultToolRegistry();
    const names = registry.getDefinitions().map((t) => t.name);
    expect(names).toContain("analyze_completion_patterns");
    expect(names).toContain("analyze_workload");
    expect(names).toContain("suggest_tags");
    expect(names).toContain("find_similar_tasks");
    expect(names).toContain("get_energy_recommendations");
    expect(names).toContain("break_down_task");
    expect(names).toContain("check_duplicates");
    expect(names).toContain("check_overcommitment");
    expect(names).toContain("plan_my_day");
    expect(names).toContain("daily_review");
    expect(names).toContain("get_productivity_stats");
    expect(names).toContain("bulk_create_tasks");
    expect(names).toContain("bulk_complete_tasks");
    expect(names).toContain("bulk_update_tasks");
    expect(registry.size).toBe(38);
  });
});

// ── analyze_completion_patterns ───────────────────────────────────────────────

describe("analyze_completion_patterns", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerAnalyzePatternsTool(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("returns zeroed stats for empty history", async () => {
    const result = await exec(registry, "analyze_completion_patterns", {}, ctx);
    expect(result.totalCompleted).toBe(0);
    expect(result.avgCompletionHours).toBe(0);
    expect(result.topTags).toEqual([]);
    expect(result.repeatedPatterns).toEqual([]);
  });

  it("counts completions by hour", async () => {
    // Create and complete a task
    const task = await taskService.create({ title: "Morning task", tags: [] });
    await taskService.complete(task.id);

    const result = await exec(registry, "analyze_completion_patterns", {}, ctx);
    expect(result.totalCompleted).toBe(1);
    // The task was completed "now", so some hour bucket should have 1
    const hourValues = Object.values(result.byHour) as number[];
    expect(hourValues.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("counts completions by weekday", async () => {
    const task = await taskService.create({ title: "Weekday task", tags: [] });
    await taskService.complete(task.id);

    const result = await exec(registry, "analyze_completion_patterns", {}, ctx);
    const weekdayValues = Object.values(result.byWeekday) as number[];
    expect(weekdayValues.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("detects repeated titles with suggested recurrence", async () => {
    // Create and complete "Buy groceries" 4 times
    for (let i = 0; i < 4; i++) {
      const task = await taskService.create({
        title: "Buy groceries",
        tags: [],
      });
      await taskService.complete(task.id);
    }

    const result = await exec(registry, "analyze_completion_patterns", {}, ctx);
    expect(result.repeatedPatterns.length).toBeGreaterThanOrEqual(1);
    const pattern = result.repeatedPatterns[0];
    expect(pattern.title).toBe("Buy groceries");
    expect(pattern.count).toBe(4);
    expect(pattern.suggestedRecurrence).toBeTruthy();
  });

  it("tracks tag frequency in completed tasks", async () => {
    const t1 = await taskService.create({
      title: "Task with tag",
      tags: ["work"],
    });
    const t2 = await taskService.create({
      title: "Another work task",
      tags: ["work", "urgent"],
    });
    await taskService.complete(t1.id);
    await taskService.complete(t2.id);

    const result = await exec(registry, "analyze_completion_patterns", {}, ctx);
    expect(result.topTags.length).toBeGreaterThanOrEqual(1);
    const workTag = result.topTags.find((t: { tag: string }) => t.tag === "work");
    expect(workTag).toBeDefined();
    expect(workTag.count).toBe(2);
  });

  it("respects days window filter", async () => {
    const task = await taskService.create({ title: "Old task", tags: [] });
    await taskService.complete(task.id);

    // With days=0 (effectively) should find nothing — but let's use days=90 and days=1
    const result90 = await exec(registry, "analyze_completion_patterns", { days: 90 }, ctx);
    expect(result90.totalCompleted).toBe(1);

    // days=1 still includes today's completions
    const result1 = await exec(registry, "analyze_completion_patterns", { days: 1 }, ctx);
    expect(result1.totalCompleted).toBe(1);
    expect(result1.daysAnalyzed).toBe(1);
  });

  it("computes average completion time", async () => {
    const task = await taskService.create({ title: "Quick task", tags: [] });
    await taskService.complete(task.id);

    const result = await exec(registry, "analyze_completion_patterns", {}, ctx);
    // Completed nearly immediately — avgCompletionHours should be very small
    expect(result.avgCompletionHours).toBeGreaterThanOrEqual(0);
  });
});

// ── analyze_workload ──────────────────────────────────────────────────────────

describe("analyze_workload", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerAnalyzeWorkloadTool(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("returns empty buckets when no tasks exist", async () => {
    const result = await exec(registry, "analyze_workload", {}, ctx);
    expect(result.days).toHaveLength(14);
    expect(result.unscheduled.count).toBe(0);
    expect(result.overdue.count).toBe(0);
    expect(result.summary.avgPerDay).toBe(0);
  });

  it("puts tasks without due dates in unscheduled", async () => {
    await taskService.create({ title: "No date task", tags: [] });
    await taskService.create({ title: "Another undated", tags: [] });

    const result = await exec(registry, "analyze_workload", {}, ctx);
    expect(result.unscheduled.count).toBe(2);
  });

  it("tracks high priority unscheduled tasks", async () => {
    await taskService.create({ title: "Urgent undated", tags: [], priority: 1 });
    await taskService.create({ title: "Low undated", tags: [], priority: 4 });

    const result = await exec(registry, "analyze_workload", {}, ctx);
    expect(result.unscheduled.count).toBe(2);
    expect(result.unscheduled.highPriority).toBe(1);
  });

  it("buckets tasks by due date", async () => {
    const today = new Date().toISOString().split("T")[0];
    const dueDate = `${today}T12:00:00.000Z`;
    await taskService.create({
      title: "Today task",
      tags: [],
      dueDate,
    });

    const result = await exec(registry, "analyze_workload", {}, ctx);
    const todayBucket = result.days.find((d: { date: string }) => d.date === today);
    expect(todayBucket).toBeDefined();
    expect(todayBucket.taskCount).toBe(1);
    expect(todayBucket.tasks[0].title).toBe("Today task");
  });

  it("detects overloaded days (>5 tasks)", async () => {
    const today = new Date().toISOString().split("T")[0];
    const dueDate = `${today}T12:00:00.000Z`;
    for (let i = 0; i < 6; i++) {
      await taskService.create({
        title: `Task ${i}`,
        tags: [],
        dueDate,
      });
    }

    const result = await exec(registry, "analyze_workload", {}, ctx);
    const todayBucket = result.days.find((d: { date: string }) => d.date === today);
    expect(todayBucket.isOverloaded).toBe(true);
  });

  it("detects light days (<2 tasks)", async () => {
    const result = await exec(registry, "analyze_workload", {}, ctx);
    // All days should be light since there are no tasks
    for (const day of result.days) {
      expect(day.isLight).toBe(true);
    }
  });

  it("identifies overdue tasks", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dueDate = `${yesterday.toISOString().split("T")[0]}T12:00:00.000Z`;
    await taskService.create({
      title: "Overdue task",
      tags: [],
      dueDate,
    });

    const result = await exec(registry, "analyze_workload", {}, ctx);
    expect(result.overdue.count).toBe(1);
    expect(result.overdue.tasks[0].title).toBe("Overdue task");
  });

  it("respects custom days parameter", async () => {
    const result = await exec(registry, "analyze_workload", { days: 7 }, ctx);
    expect(result.days).toHaveLength(7);
  });

  it("computes busiest and lightest day", async () => {
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayStr = today.toISOString().split("T")[0];
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    await taskService.create({
      title: "Task A",
      tags: [],
      dueDate: `${todayStr}T12:00:00.000Z`,
    });
    await taskService.create({
      title: "Task B",
      tags: [],
      dueDate: `${todayStr}T12:00:00.000Z`,
    });
    await taskService.create({
      title: "Task C",
      tags: [],
      dueDate: `${tomorrowStr}T12:00:00.000Z`,
    });

    const result = await exec(registry, "analyze_workload", {}, ctx);
    expect(result.summary.busiestDay.date).toBe(todayStr);
    expect(result.summary.busiestDay.taskCount).toBe(2);
  });
});

// ── suggest_tags ──────────────────────────────────────────────────────────────

describe("suggest_tags", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerSmartOrganizeTools(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("suggests tags based on similar titled tasks", async () => {
    await taskService.create({
      title: "Buy groceries at store",
      tags: ["shopping", "errands"],
    });
    await taskService.create({
      title: "Buy vegetables at store",
      tags: ["shopping", "health"],
    });
    const target = await taskService.create({
      title: "Buy fruits at store",
      tags: [],
    });

    const result = await exec(registry, "suggest_tags", { taskId: target.id }, ctx);
    expect(result.taskTitle).toBe("Buy fruits at store");
    expect(result.suggestedTags.length).toBeGreaterThan(0);
    const tagNames = result.suggestedTags.map((t: { tag: string }) => t.tag);
    expect(tagNames).toContain("shopping");
  });

  it("returns empty suggestions when no word overlap", async () => {
    await taskService.create({
      title: "Clean the house",
      tags: ["chores"],
    });
    const target = await taskService.create({
      title: "Deploy production server",
      tags: [],
    });

    const result = await exec(registry, "suggest_tags", { taskId: target.id }, ctx);
    expect(result.suggestedTags).toHaveLength(0);
  });

  it("excludes existing tags from suggestions", async () => {
    await taskService.create({
      title: "Write report for meeting",
      tags: ["work"],
    });
    const target = await taskService.create({
      title: "Write summary for meeting",
      tags: ["work"],
    });

    const result = await exec(registry, "suggest_tags", { taskId: target.id }, ctx);
    const tagNames = result.suggestedTags.map((t: { tag: string }) => t.tag);
    expect(tagNames).not.toContain("work");
    expect(result.existingTags).toContain("work");
  });

  it("returns error for non-existent task", async () => {
    const result = await exec(registry, "suggest_tags", { taskId: "nonexistent" }, ctx);
    expect(result.error).toBeDefined();
  });
});

// ── find_similar_tasks ────────────────────────────────────────────────────────

describe("find_similar_tasks", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerSmartOrganizeTools(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("finds groups of identical titles", async () => {
    await taskService.create({ title: "Buy milk from store", tags: [] });
    await taskService.create({ title: "Buy milk from store", tags: [] });
    await taskService.create({ title: "Something completely different", tags: [] });

    const result = await exec(
      registry,
      "find_similar_tasks",
      { search: "Buy milk from store" },
      ctx,
    );
    expect(result.groups.length).toBeGreaterThanOrEqual(1);
    expect(result.groups[0].tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty groups when no similar tasks", async () => {
    await taskService.create({ title: "Alpha beta gamma", tags: [] });

    const result = await exec(
      registry,
      "find_similar_tasks",
      { search: "Completely unrelated xyz" },
      ctx,
    );
    expect(result.groups).toHaveLength(0);
  });

  it("finds similar tasks by taskId", async () => {
    const ref = await taskService.create({
      title: "Review quarterly budget report",
      tags: [],
    });
    await taskService.create({
      title: "Review annual budget report",
      tags: [],
    });

    const result = await exec(registry, "find_similar_tasks", { taskId: ref.id }, ctx);
    expect(result.groups.length).toBeGreaterThanOrEqual(1);
    const similar = result.groups[0].tasks;
    expect(similar.some((t: { title: string }) => t.title.includes("annual"))).toBe(true);
  });

  it("returns error for non-existent taskId", async () => {
    const result = await exec(registry, "find_similar_tasks", { taskId: "nonexistent" }, ctx);
    expect(result.error).toBeDefined();
  });

  it("finds all similar groups when no reference given", async () => {
    await taskService.create({ title: "Buy groceries milk eggs", tags: [] });
    await taskService.create({ title: "Buy groceries milk bread", tags: [] });
    await taskService.create({ title: "Something completely different indeed", tags: [] });

    const result = await exec(registry, "find_similar_tasks", {}, ctx);
    // "Buy groceries milk eggs" and "Buy groceries milk bread" share 3/5 words = 0.6 Jaccard
    expect(result.groups.length).toBeGreaterThanOrEqual(1);
  });
});

// ── get_energy_recommendations ────────────────────────────────────────────────

describe("get_energy_recommendations", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerEnergyRecommendationsTool(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("returns empty recommendations when no tasks", async () => {
    const result = await exec(registry, "get_energy_recommendations", {}, ctx);
    expect(result.quickWins).toHaveLength(0);
    expect(result.deepWork).toHaveLength(0);
    expect(result.recommended).toHaveLength(0);
    expect(result.energyLevel).toBe("medium");
    expect(result.availableMinutes).toBe(60);
  });

  it("classifies short tasks as quick wins", async () => {
    await taskService.create({ title: "Reply email", tags: [] });
    await taskService.create({ title: "Check messages", tags: [] });

    const result = await exec(registry, "get_energy_recommendations", {}, ctx);
    expect(result.quickWins.length).toBe(2);
    expect(result.quickWins[0].category).toBe("quick_win");
    expect(result.quickWins[0].estimatedMinutes).toBe(10);
  });

  it("classifies high-priority tasks as deep work", async () => {
    await taskService.create({
      title: "Fix bug",
      tags: [],
      priority: 1,
    });

    const result = await exec(registry, "get_energy_recommendations", {}, ctx);
    expect(result.deepWork.length).toBe(1);
    expect(result.deepWork[0].category).toBe("deep_work");
    expect(result.deepWork[0].estimatedMinutes).toBe(45);
  });

  it("classifies tasks with description as deep work", async () => {
    await taskService.create({
      title: "Plan",
      tags: [],
      description: "This is a detailed description of what needs to be planned.",
    });

    const result = await exec(registry, "get_energy_recommendations", {}, ctx);
    expect(result.deepWork.length).toBe(1);
  });

  it("classifies long titles as deep work", async () => {
    await taskService.create({
      title: "Research and write a comprehensive report about market trends in Q4",
      tags: [],
    });

    const result = await exec(registry, "get_energy_recommendations", {}, ctx);
    expect(result.deepWork.length).toBe(1);
  });

  it("low energy returns only quick wins", async () => {
    await taskService.create({ title: "Quick task", tags: [] });
    await taskService.create({
      title: "Fix critical infrastructure bug",
      tags: [],
      priority: 1,
    });

    const result = await exec(registry, "get_energy_recommendations", { energy_level: "low" }, ctx);
    // Recommended should only contain quick wins
    for (const task of result.recommended) {
      expect(task.category).toBe("quick_win");
    }
  });

  it("high energy prioritizes deep work", async () => {
    await taskService.create({ title: "Quick task", tags: [] });
    await taskService.create({
      title: "Design new architecture for the authentication system",
      tags: [],
      priority: 1,
    });

    const result = await exec(
      registry,
      "get_energy_recommendations",
      { energy_level: "high", available_minutes: 120 },
      ctx,
    );
    // First recommended should be deep work
    expect(result.recommended[0].category).toBe("deep_work");
  });

  it("respects available_minutes budget", async () => {
    // Create 10 quick wins — each is ~10 min = 100 min total
    for (let i = 0; i < 10; i++) {
      await taskService.create({ title: `Task ${i}`, tags: [] });
    }

    const result = await exec(
      registry,
      "get_energy_recommendations",
      { available_minutes: 30 },
      ctx,
    );
    expect(result.estimatedMinutes).toBeLessThanOrEqual(30);
    expect(result.recommended.length).toBe(3); // 3 × 10 = 30 minutes
  });

  it("always returns at least one task if any exist", async () => {
    // One deep work task (45 min) but only 5 minutes available
    await taskService.create({
      title: "Refactor the entire database layer for better performance",
      tags: [],
      priority: 1,
    });

    const result = await exec(
      registry,
      "get_energy_recommendations",
      { available_minutes: 5, energy_level: "high" },
      ctx,
    );
    expect(result.recommended.length).toBe(1);
  });

  it("excludes subtasks from recommendations", async () => {
    const parent = await taskService.create({
      title: "Parent task",
      tags: [],
      priority: 2,
    });
    await taskService.create({
      title: "Child task",
      tags: [],
      parentId: parent.id,
    });

    const result = await exec(registry, "get_energy_recommendations", {}, ctx);
    const titles = [
      ...result.quickWins.map((t: { title: string }) => t.title),
      ...result.deepWork.map((t: { title: string }) => t.title),
    ];
    expect(titles).not.toContain("Child task");
  });

  it("treats tasks with subtasks as deep work", async () => {
    const parent = await taskService.create({
      title: "Ship",
      tags: [],
    });
    await taskService.create({
      title: "Step one",
      tags: [],
      parentId: parent.id,
    });

    const result = await exec(registry, "get_energy_recommendations", {}, ctx);
    // "Ship" has subtasks so it should be deep work despite short title
    expect(result.deepWork.some((t: { title: string }) => t.title === "Ship")).toBe(true);
  });
});

// ── check_duplicates ──────────────────────────────────────────────────────────

describe("check_duplicates", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerCheckDuplicatesTool(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("returns no matches for unique title", async () => {
    await taskService.create({ title: "Buy groceries at the store", tags: [] });

    const result = await exec(
      registry,
      "check_duplicates",
      { title: "Deploy production server immediately" },
      ctx,
    );
    expect(result.duplicatesFound).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it("detects duplicate title (high similarity)", async () => {
    await taskService.create({ title: "Buy groceries at the store", tags: [] });

    const result = await exec(
      registry,
      "check_duplicates",
      { title: "Buy groceries at the store" },
      ctx,
    );
    expect(result.duplicatesFound).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].similarity).toBeGreaterThanOrEqual(0.5);
  });

  it("respects threshold parameter", async () => {
    await taskService.create({ title: "Buy groceries milk eggs", tags: [] });

    // Low threshold should find the match
    const resultLow = await exec(
      registry,
      "check_duplicates",
      { title: "Buy groceries milk bread", threshold: 0.3 },
      ctx,
    );
    expect(resultLow.duplicatesFound).toBe(true);

    // Very high threshold should not
    const resultHigh = await exec(
      registry,
      "check_duplicates",
      { title: "Buy groceries milk bread", threshold: 0.99 },
      ctx,
    );
    expect(resultHigh.duplicatesFound).toBe(false);
  });

  it("returns similarity score", async () => {
    await taskService.create({ title: "Buy milk from store", tags: [] });

    const result = await exec(
      registry,
      "check_duplicates",
      { title: "Buy milk from store", threshold: 0.3 },
      ctx,
    );
    expect(result.matches[0].similarity).toBe(1);
  });

  it("only checks pending tasks (not completed)", async () => {
    const task = await taskService.create({ title: "Buy groceries at store", tags: [] });
    await taskService.complete(task.id);

    const result = await exec(
      registry,
      "check_duplicates",
      { title: "Buy groceries at store" },
      ctx,
    );
    expect(result.duplicatesFound).toBe(false);
  });

  it("handles empty task list", async () => {
    const result = await exec(registry, "check_duplicates", { title: "Any task title" }, ctx);
    expect(result.duplicatesFound).toBe(false);
    expect(result.matches).toHaveLength(0);
  });
});

// ── check_overcommitment ──────────────────────────────────────────────────────

describe("check_overcommitment", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let taskService: TaskService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerCheckOvercommitmentTool(registry);
    const services = createTestServices();
    taskService = services.taskService;
    ctx = { taskService, projectService: services.projectService };
  });

  it("returns not overloaded for light day", async () => {
    const today = new Date().toISOString().split("T")[0];
    await taskService.create({
      title: "One task",
      tags: [],
      dueDate: `${today}T12:00:00.000Z`,
    });

    const result = await exec(registry, "check_overcommitment", { date: today }, ctx);
    expect(result.isOverloaded).toBe(false);
    expect(result.taskCount).toBe(1);
    expect(result.suggestion).toBeNull();
  });

  it("returns overloaded when >5 tasks on date", async () => {
    const today = new Date().toISOString().split("T")[0];
    for (let i = 0; i < 6; i++) {
      await taskService.create({
        title: `Task ${i}`,
        tags: [],
        dueDate: `${today}T12:00:00.000Z`,
      });
    }

    const result = await exec(registry, "check_overcommitment", { date: today }, ctx);
    expect(result.isOverloaded).toBe(true);
    expect(result.taskCount).toBe(6);
    expect(result.suggestion).toBeTruthy();
  });

  it("returns overloaded when priority weight >12", async () => {
    const today = new Date().toISOString().split("T")[0];
    // 4 P1 tasks = priority weight 16 (4 * 4)
    for (let i = 0; i < 4; i++) {
      await taskService.create({
        title: `Urgent ${i}`,
        tags: [],
        priority: 1,
        dueDate: `${today}T12:00:00.000Z`,
      });
    }

    const result = await exec(registry, "check_overcommitment", { date: today }, ctx);
    expect(result.isOverloaded).toBe(true);
    expect(result.priorityWeight).toBe(16);
  });

  it("counts overdue tasks", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    await taskService.create({
      title: "Overdue task",
      tags: [],
      dueDate: `${yesterdayStr}T12:00:00.000Z`,
    });

    const result = await exec(registry, "check_overcommitment", {}, ctx);
    expect(result.overdue).toBe(1);
  });

  it("defaults to today when no date provided", async () => {
    const today = new Date().toISOString().split("T")[0];

    const result = await exec(registry, "check_overcommitment", {}, ctx);
    expect(result.date).toBe(today);
  });

  it("suggests lighter day when overloaded", async () => {
    const today = new Date().toISOString().split("T")[0];
    for (let i = 0; i < 6; i++) {
      await taskService.create({
        title: `Task ${i}`,
        tags: [],
        dueDate: `${today}T12:00:00.000Z`,
      });
    }

    const result = await exec(registry, "check_overcommitment", { date: today }, ctx);
    expect(result.suggestion).toMatch(/You have 6 tasks/);
    expect(result.suggestion).toMatch(/Consider/);
  });
});
