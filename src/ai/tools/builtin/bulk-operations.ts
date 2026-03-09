/**
 * Bulk operation tools for creating, completing, and updating multiple tasks.
 * Enables "brain dump" workflows where users describe multiple tasks at once.
 */

import type { ToolRegistry } from "../registry.js";

export function registerBulkOperationTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "bulk_create_tasks",
      description:
        "Create multiple tasks at once. Perfect for brain dumps, meeting notes, or planning sessions. Extract each actionable item as a separate task.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
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
                estimatedMinutes: {
                  type: "integer",
                  description: "Estimated duration in minutes",
                },
              },
              required: ["title"],
            },
            minItems: 1,
            maxItems: 20,
            description: "Array of tasks to create (1-20 items)",
          },
        },
        required: ["tasks"],
      },
    },
    async (args, ctx) => {
      const tasks = args.tasks as Array<{
        title: string;
        priority?: number;
        dueDate?: string;
        tags?: string[];
        projectId?: string;
        estimatedMinutes?: number;
      }>;

      const created = [];
      for (const t of tasks) {
        const task = await ctx.taskService.create({
          title: t.title,
          priority: t.priority ?? null,
          dueDate: t.dueDate ?? null,
          dueTime: false,
          tags: t.tags ?? [],
          projectId: t.projectId ?? null,
          recurrence: null,
          remindAt: null,
          estimatedMinutes: t.estimatedMinutes ?? null,
          deadline: null,
          isSomeday: false,
          sectionId: null,
        });
        created.push({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
          projectId: task.projectId,
          tags: task.tags,
        });
      }

      return JSON.stringify({ success: true, created, count: created.length });
    },
  );

  registry.register(
    {
      name: "bulk_complete_tasks",
      description: "Mark multiple tasks as completed at once. Provide task IDs (from query_tasks).",
      parameters: {
        type: "object",
        properties: {
          taskIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
            description: "Array of task IDs to complete (1-50)",
          },
        },
        required: ["taskIds"],
      },
    },
    async (args, ctx) => {
      const ids = args.taskIds as string[];
      const results = await ctx.taskService.completeMany(ids);
      const completed = results.map((t) => ({ id: t.id, title: t.title }));
      return JSON.stringify({ success: true, completed, count: completed.length });
    },
  );

  registry.register(
    {
      name: "bulk_update_tasks",
      description:
        "Update multiple tasks with the same changes at once. Useful for batch priority, date, project, or tag updates.",
      parameters: {
        type: "object",
        properties: {
          taskIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
            description: "Array of task IDs to update (1-50)",
          },
          changes: {
            type: "object",
            properties: {
              priority: {
                type: "number",
                description: "New priority 1-4",
                enum: [1, 2, 3, 4],
              },
              dueDate: {
                type: "string",
                description: "New due date as ISO 8601 string",
              },
              projectId: {
                type: "string",
                description: "Project ID to assign all tasks to",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Replace all tags on each task with these tag names",
              },
              status: {
                type: "string",
                description: "New status",
                enum: ["pending", "completed", "cancelled"],
              },
            },
            description: "Changes to apply to all specified tasks",
          },
        },
        required: ["taskIds", "changes"],
      },
    },
    async (args, ctx) => {
      const ids = args.taskIds as string[];
      const changes = args.changes as Record<string, unknown>;
      const results = await ctx.taskService.updateMany(ids, changes);
      const updated = results.map((t) => ({ id: t.id, title: t.title }));
      return JSON.stringify({ success: true, updated, count: updated.length });
    },
  );
}
