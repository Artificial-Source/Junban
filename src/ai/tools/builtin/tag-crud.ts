/**
 * Built-in tools for tag/label management.
 * Registers: list_tags, add_tags_to_task, remove_tags_from_task
 */

import type { ToolRegistry } from "../registry.js";

export function registerTagCrudTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "list_tags",
      description: "List all tags/labels that exist in the system. Returns tag names and colors.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    async (_args, ctx) => {
      if (!ctx.tagService) {
        return JSON.stringify({ error: "Tag service not available" });
      }
      const tags = await ctx.tagService.list();
      return JSON.stringify({
        count: tags.length,
        tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      });
    },
  );

  registry.register(
    {
      name: "add_tags_to_task",
      description:
        "Add one or more tags/labels to a task without removing existing tags. Creates tags if they don't exist.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to add tags to",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tag names to add",
          },
        },
        required: ["taskId", "tags"],
      },
    },
    async (args, ctx) => {
      const taskId = args.taskId as string;
      const newTags = args.tags as string[];

      // Get current task to preserve existing tags
      const task = await ctx.taskService.get(taskId);
      if (!task) {
        return JSON.stringify({ error: "Task not found" });
      }

      const existingTagNames = task.tags.map((t) => t.name);
      const mergedTags = [...new Set([...existingTagNames, ...newTags])];

      const updated = await ctx.taskService.update(taskId, { tags: mergedTags });
      return JSON.stringify({
        success: true,
        task: {
          id: updated.id,
          title: updated.title,
          tags: updated.tags.map((t) => t.name),
        },
      });
    },
  );

  registry.register(
    {
      name: "remove_tags_from_task",
      description: "Remove one or more tags/labels from a task, keeping all other tags intact.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to remove tags from",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tag names to remove",
          },
        },
        required: ["taskId", "tags"],
      },
    },
    async (args, ctx) => {
      const taskId = args.taskId as string;
      const tagsToRemove = new Set((args.tags as string[]).map((t) => t.toLowerCase()));

      const task = await ctx.taskService.get(taskId);
      if (!task) {
        return JSON.stringify({ error: "Task not found" });
      }

      const remainingTags = task.tags
        .map((t) => t.name)
        .filter((name) => !tagsToRemove.has(name.toLowerCase()));

      const updated = await ctx.taskService.update(taskId, { tags: remainingTags });
      return JSON.stringify({
        success: true,
        task: {
          id: updated.id,
          title: updated.title,
          tags: updated.tags.map((t) => t.name),
        },
      });
    },
  );
}
