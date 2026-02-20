/**
 * Built-in reminder management tools for the AI assistant.
 * Registers: list_reminders, set_reminder, snooze_reminder, dismiss_reminder
 */

import type { ToolRegistry } from "../registry.js";

export function registerReminderTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "list_reminders",
      description:
        "List tasks that have reminders set. Can filter to show only overdue reminders, upcoming reminders, or all.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description:
              'Filter reminders: "overdue" (past due, still pending), "upcoming" (future), "all" (default). Only shows pending tasks.',
            enum: ["overdue", "upcoming", "all"],
          },
        },
      },
    },
    async (_args, ctx) => {
      const filter = (_args.filter as string) ?? "all";
      const tasks = await ctx.taskService.list({ status: "pending" });
      const withReminders = tasks.filter((t) => t.remindAt !== null);
      const now = new Date().toISOString();

      let filtered;
      if (filter === "overdue") {
        filtered = withReminders.filter((t) => t.remindAt! <= now);
      } else if (filter === "upcoming") {
        filtered = withReminders.filter((t) => t.remindAt! > now);
      } else {
        filtered = withReminders;
      }

      // Sort by remindAt ascending
      filtered.sort((a, b) => a.remindAt!.localeCompare(b.remindAt!));

      return JSON.stringify({
        count: filtered.length,
        filter,
        reminders: filtered.map((t) => ({
          taskId: t.id,
          title: t.title,
          remindAt: t.remindAt,
          dueDate: t.dueDate,
          priority: t.priority,
          isOverdue: t.remindAt! <= now,
        })),
      });
    },
  );

  registry.register(
    {
      name: "set_reminder",
      description:
        "Set or update a reminder on an existing task. Provide an absolute ISO 8601 datetime, or a relative offset like '1 hour before due'.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to set a reminder on",
          },
          remindAt: {
            type: "string",
            description: "Reminder time as ISO 8601 datetime (e.g. '2026-02-18T10:00:00.000Z')",
          },
        },
        required: ["taskId", "remindAt"],
      },
    },
    async (args, ctx) => {
      const taskId = args.taskId as string;
      const remindAt = args.remindAt as string;

      // Validate the datetime
      const parsed = new Date(remindAt);
      if (isNaN(parsed.getTime())) {
        return JSON.stringify({ error: "Invalid datetime format for remindAt" });
      }

      const task = await ctx.taskService.update(taskId, { remindAt });
      return JSON.stringify({
        success: true,
        task: {
          id: task.id,
          title: task.title,
          remindAt: task.remindAt,
          dueDate: task.dueDate,
        },
      });
    },
  );

  registry.register(
    {
      name: "snooze_reminder",
      description:
        "Push a task's reminder forward by a specified duration. Useful when a reminder fires but the user isn't ready yet.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to snooze",
          },
          minutes: {
            type: "number",
            description: "Minutes to snooze by. Common values: 15, 30, 60, 120, 1440 (1 day)",
          },
        },
        required: ["taskId", "minutes"],
      },
    },
    async (args, ctx) => {
      const taskId = args.taskId as string;
      const minutes = args.minutes as number;

      if (minutes <= 0) {
        return JSON.stringify({ error: "Minutes must be a positive number" });
      }

      const task = await ctx.taskService.get(taskId);
      if (!task) {
        return JSON.stringify({ error: "Task not found" });
      }

      // Snooze from current remindAt or from now if no reminder is set
      const base = task.remindAt ? new Date(task.remindAt) : new Date();
      const snoozed = new Date(base.getTime() + minutes * 60_000);
      const newRemindAt = snoozed.toISOString();

      const updated = await ctx.taskService.update(taskId, { remindAt: newRemindAt });
      return JSON.stringify({
        success: true,
        task: {
          id: updated.id,
          title: updated.title,
          remindAt: updated.remindAt,
          previousRemindAt: task.remindAt,
          snoozedByMinutes: minutes,
        },
      });
    },
  );

  registry.register(
    {
      name: "dismiss_reminder",
      description:
        "Clear the reminder from a task without completing it. The task remains pending but will no longer trigger a reminder.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task whose reminder to dismiss",
          },
        },
        required: ["taskId"],
      },
    },
    async (args, ctx) => {
      const taskId = args.taskId as string;

      const task = await ctx.taskService.get(taskId);
      if (!task) {
        return JSON.stringify({ error: "Task not found" });
      }

      if (!task.remindAt) {
        return JSON.stringify({ error: "Task has no reminder set" });
      }

      const previousRemindAt = task.remindAt;
      const updated = await ctx.taskService.update(taskId, { remindAt: null });
      return JSON.stringify({
        success: true,
        task: {
          id: updated.id,
          title: updated.title,
          remindAt: updated.remindAt,
          previousRemindAt,
        },
      });
    },
  );
}
