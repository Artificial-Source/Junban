/**
 * Built-in CRUD tools for task management.
 * Registers: create_task, update_task, complete_task, delete_task
 */

import type { ToolRegistry } from "../registry.js";

export function registerTaskCrudTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "create_task",
      description:
        "Create a new task. Supports priority, due date, tags, project, recurrence pattern, and reminder.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title (required)" },
          priority: {
            type: "number",
            description: "Priority 1-4 (1=urgent, 4=low)",
            enum: [1, 2, 3, 4],
          },
          dueDate: {
            type: "string",
            description: "Due date as ISO 8601 string",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tag names",
          },
          projectId: {
            type: "string",
            description: "Project ID to assign to",
          },
          recurrence: {
            type: "string",
            description:
              'Recurrence pattern: "daily", "weekly", "monthly", "yearly", or cron-like (e.g. "every 2 weeks")',
          },
          remindAt: {
            type: "string",
            description:
              "Reminder date/time as ISO 8601 string. When set, the user will be notified at this time.",
          },
        },
        required: ["title"],
      },
    },
    async (args, ctx) => {
      const task = await ctx.taskService.create({
        title: args.title as string,
        priority: (args.priority as number) ?? null,
        dueDate: (args.dueDate as string) ?? null,
        dueTime: false,
        tags: (args.tags as string[]) ?? [],
        projectId: (args.projectId as string) ?? null,
        recurrence: (args.recurrence as string) ?? null,
        remindAt: (args.remindAt as string) ?? null,
      });
      return JSON.stringify({
        success: true,
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
          projectId: task.projectId,
          tags: task.tags,
        },
      });
    },
  );

  registry.register(
    {
      name: "update_task",
      description:
        "Update an existing task's fields. Supports title, priority, due date, tags, recurrence, and reminder.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to update",
          },
          title: { type: "string", description: "New title" },
          priority: {
            type: "number",
            description: "New priority 1-4",
            enum: [1, 2, 3, 4],
          },
          dueDate: {
            type: "string",
            description: "New due date as ISO 8601 string",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Replace all tags with these tag names",
          },
          recurrence: {
            type: "string",
            description:
              'Recurrence pattern: "daily", "weekly", etc. Set to empty string to remove.',
          },
          remindAt: {
            type: "string",
            description: "Reminder date/time as ISO 8601 string. Set to empty string to remove.",
          },
        },
        required: ["taskId"],
      },
    },
    async (args, ctx) => {
      const { taskId, ...updates } = args;
      // Convert empty strings to null for clearing fields
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value === "") {
          cleaned[key] = null;
        } else {
          cleaned[key] = value;
        }
      }
      const task = await ctx.taskService.update(taskId as string, cleaned);
      return JSON.stringify({
        success: true,
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
          projectId: task.projectId,
          tags: task.tags,
        },
      });
    },
  );

  registry.register(
    {
      name: "complete_task",
      description:
        "Mark a task as completed. If the task has a recurrence pattern, a new occurrence will be created automatically.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to complete",
          },
        },
        required: ["taskId"],
      },
    },
    async (args, ctx) => {
      const task = await ctx.taskService.complete(args.taskId as string);
      return JSON.stringify({
        success: true,
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
          projectId: task.projectId,
          tags: task.tags,
        },
      });
    },
  );

  registry.register(
    {
      name: "delete_task",
      description: "Permanently delete a task.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to delete",
          },
        },
        required: ["taskId"],
      },
    },
    async (args, ctx) => {
      const deleted = await ctx.taskService.delete(args.taskId as string);
      return JSON.stringify({ success: true, deleted });
    },
  );
}
