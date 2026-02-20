import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerReminderTools } from "../../src/ai/tools/builtin/reminder-tools.js";
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

// ── list_reminders ────────────────────────────────────────────────────────────

describe("list_reminders", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerReminderTools(registry);
    registerTaskCrudTools(registry);
    const services = createTestServices();
    ctx = { taskService: services.taskService, projectService: services.projectService };
  });

  it("returns empty list when no reminders exist", async () => {
    await ctx.taskService.create({ title: "No reminder", tags: [] });

    const result = await exec(registry, "list_reminders", {}, ctx);
    expect(result.count).toBe(0);
    expect(result.reminders).toEqual([]);
  });

  it("lists all tasks with reminders", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();

    await ctx.taskService.create({ title: "Future reminder", tags: [], remindAt: future });
    await ctx.taskService.create({ title: "Past reminder", tags: [], remindAt: past });
    await ctx.taskService.create({ title: "No reminder", tags: [] });

    const result = await exec(registry, "list_reminders", {}, ctx);
    expect(result.count).toBe(2);
    expect(result.filter).toBe("all");
  });

  it("filters overdue reminders only", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();

    await ctx.taskService.create({ title: "Future", tags: [], remindAt: future });
    await ctx.taskService.create({ title: "Overdue", tags: [], remindAt: past });

    const result = await exec(registry, "list_reminders", { filter: "overdue" }, ctx);
    expect(result.count).toBe(1);
    expect(result.reminders[0].title).toBe("Overdue");
    expect(result.reminders[0].isOverdue).toBe(true);
  });

  it("filters upcoming reminders only", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();

    await ctx.taskService.create({ title: "Future", tags: [], remindAt: future });
    await ctx.taskService.create({ title: "Overdue", tags: [], remindAt: past });

    const result = await exec(registry, "list_reminders", { filter: "upcoming" }, ctx);
    expect(result.count).toBe(1);
    expect(result.reminders[0].title).toBe("Future");
    expect(result.reminders[0].isOverdue).toBe(false);
  });

  it("sorts reminders by remindAt ascending", async () => {
    const soon = new Date(Date.now() + 1800_000).toISOString();
    const later = new Date(Date.now() + 7200_000).toISOString();

    await ctx.taskService.create({ title: "Later", tags: [], remindAt: later });
    await ctx.taskService.create({ title: "Sooner", tags: [], remindAt: soon });

    const result = await exec(registry, "list_reminders", {}, ctx);
    expect(result.reminders[0].title).toBe("Sooner");
    expect(result.reminders[1].title).toBe("Later");
  });

  it("excludes completed tasks from reminders", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const task = await ctx.taskService.create({
      title: "Done task",
      tags: [],
      remindAt: future,
    });
    await ctx.taskService.complete(task.id);

    const result = await exec(registry, "list_reminders", {}, ctx);
    expect(result.count).toBe(0);
  });

  it("includes task metadata in reminder list", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const dueDate = new Date(Date.now() + 7200_000).toISOString();

    await ctx.taskService.create({
      title: "Important meeting",
      tags: [],
      remindAt: future,
      dueDate,
      priority: 1,
    });

    const result = await exec(registry, "list_reminders", {}, ctx);
    expect(result.reminders[0].dueDate).toBe(dueDate);
    expect(result.reminders[0].priority).toBe(1);
    expect(result.reminders[0].taskId).toBeDefined();
  });
});

// ── set_reminder ──────────────────────────────────────────────────────────────

describe("set_reminder", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerReminderTools(registry);
    const services = createTestServices();
    ctx = { taskService: services.taskService, projectService: services.projectService };
  });

  it("sets a reminder on a task", async () => {
    const task = await ctx.taskService.create({ title: "Remind me", tags: [] });
    const remindAt = "2026-02-18T10:00:00.000Z";

    const result = await exec(registry, "set_reminder", { taskId: task.id, remindAt }, ctx);
    expect(result.success).toBe(true);
    expect(result.task.remindAt).toBe(remindAt);
    expect(result.task.title).toBe("Remind me");
  });

  it("updates an existing reminder", async () => {
    const task = await ctx.taskService.create({
      title: "Update me",
      tags: [],
      remindAt: "2026-02-17T08:00:00.000Z",
    });
    const newRemindAt = "2026-02-18T10:00:00.000Z";

    const result = await exec(
      registry,
      "set_reminder",
      { taskId: task.id, remindAt: newRemindAt },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.task.remindAt).toBe(newRemindAt);
  });

  it("returns error for invalid datetime", async () => {
    const task = await ctx.taskService.create({ title: "Bad date", tags: [] });

    const result = await exec(
      registry,
      "set_reminder",
      { taskId: task.id, remindAt: "not-a-date" },
      ctx,
    );
    expect(result.error).toBe("Invalid datetime format for remindAt");
  });
});

// ── snooze_reminder ───────────────────────────────────────────────────────────

describe("snooze_reminder", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerReminderTools(registry);
    const services = createTestServices();
    ctx = { taskService: services.taskService, projectService: services.projectService };
  });

  it("snoozes a reminder by specified minutes", async () => {
    const originalRemindAt = "2026-02-16T10:00:00.000Z";
    const task = await ctx.taskService.create({
      title: "Snooze me",
      tags: [],
      remindAt: originalRemindAt,
    });

    const result = await exec(registry, "snooze_reminder", { taskId: task.id, minutes: 30 }, ctx);
    expect(result.success).toBe(true);
    expect(result.task.previousRemindAt).toBe(originalRemindAt);
    expect(result.task.snoozedByMinutes).toBe(30);

    // Verify the new time is 30 minutes later
    const expected = new Date(new Date(originalRemindAt).getTime() + 30 * 60_000).toISOString();
    expect(result.task.remindAt).toBe(expected);
  });

  it("snoozes from now if no reminder was set", async () => {
    const task = await ctx.taskService.create({
      title: "No existing reminder",
      tags: [],
    });
    const before = Date.now();

    const result = await exec(registry, "snooze_reminder", { taskId: task.id, minutes: 60 }, ctx);
    expect(result.success).toBe(true);

    const snoozedTime = new Date(result.task.remindAt).getTime();
    // Should be approximately 60 minutes from now
    expect(snoozedTime).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(snoozedTime).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
  });

  it("returns error for non-existent task", async () => {
    const result = await exec(
      registry,
      "snooze_reminder",
      { taskId: "nonexistent", minutes: 15 },
      ctx,
    );
    expect(result.error).toBe("Task not found");
  });

  it("returns error for non-positive minutes", async () => {
    const task = await ctx.taskService.create({ title: "Nope", tags: [] });

    const result = await exec(registry, "snooze_reminder", { taskId: task.id, minutes: 0 }, ctx);
    expect(result.error).toBe("Minutes must be a positive number");
  });

  it("snoozes by 1 day (1440 minutes)", async () => {
    const originalRemindAt = "2026-02-16T09:00:00.000Z";
    const task = await ctx.taskService.create({
      title: "Snooze 1 day",
      tags: [],
      remindAt: originalRemindAt,
    });

    const result = await exec(registry, "snooze_reminder", { taskId: task.id, minutes: 1440 }, ctx);
    expect(result.success).toBe(true);
    expect(result.task.remindAt).toBe("2026-02-17T09:00:00.000Z");
  });
});

// ── dismiss_reminder ──────────────────────────────────────────────────────────

describe("dismiss_reminder", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerReminderTools(registry);
    const services = createTestServices();
    ctx = { taskService: services.taskService, projectService: services.projectService };
  });

  it("clears a reminder from a task", async () => {
    const task = await ctx.taskService.create({
      title: "Dismiss me",
      tags: [],
      remindAt: "2026-02-18T10:00:00.000Z",
    });

    const result = await exec(registry, "dismiss_reminder", { taskId: task.id }, ctx);
    expect(result.success).toBe(true);
    expect(result.task.remindAt).toBeNull();
    expect(result.task.previousRemindAt).toBe("2026-02-18T10:00:00.000Z");

    // Verify the task still exists and is pending
    const fetched = await ctx.taskService.get(task.id);
    expect(fetched!.status).toBe("pending");
    expect(fetched!.remindAt).toBeNull();
  });

  it("returns error for non-existent task", async () => {
    const result = await exec(registry, "dismiss_reminder", { taskId: "nonexistent" }, ctx);
    expect(result.error).toBe("Task not found");
  });

  it("returns error when task has no reminder", async () => {
    const task = await ctx.taskService.create({
      title: "No reminder",
      tags: [],
    });

    const result = await exec(registry, "dismiss_reminder", { taskId: task.id }, ctx);
    expect(result.error).toBe("Task has no reminder set");
  });
});

// ── Cross-tool integration (reminder + task) ────────────────────────────────

describe("Cross-tool integration (reminder + task)", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerReminderTools(registry);
    registerTaskCrudTools(registry);
    const services = createTestServices();
    ctx = { taskService: services.taskService, projectService: services.projectService };
  });

  it("creates a task with reminder then lists it", async () => {
    const remindAt = new Date(Date.now() + 3600_000).toISOString();
    await exec(registry, "create_task", { title: "Leave for Guadalajara", remindAt }, ctx);

    const reminders = await exec(registry, "list_reminders", {}, ctx);
    expect(reminders.count).toBe(1);
    expect(reminders.reminders[0].title).toBe("Leave for Guadalajara");
  });

  it("sets a reminder then snoozes then dismisses it", async () => {
    const task = await ctx.taskService.create({ title: "Multi-step", tags: [] });

    // Set reminder
    const remindAt = "2026-02-18T10:00:00.000Z";
    await exec(registry, "set_reminder", { taskId: task.id, remindAt }, ctx);

    // Snooze by 30 minutes
    const snoozed = await exec(registry, "snooze_reminder", { taskId: task.id, minutes: 30 }, ctx);
    expect(snoozed.task.remindAt).toBe("2026-02-18T10:30:00.000Z");

    // Dismiss
    const dismissed = await exec(registry, "dismiss_reminder", { taskId: task.id }, ctx);
    expect(dismissed.task.remindAt).toBeNull();

    // Verify no reminders left
    const reminders = await exec(registry, "list_reminders", {}, ctx);
    expect(reminders.count).toBe(0);
  });
});
