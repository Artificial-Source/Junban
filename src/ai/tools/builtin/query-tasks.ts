/**
 * query_tasks tool — replaces the old list_tasks with full TaskFilter support.
 * Solves GitHub Issue #9.
 */

import type { ToolRegistry } from "../registry.js";
import type { TaskFilter } from "../../../core/filters.js";

export function registerQueryTasksTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "query_tasks",
      description:
        "Search and filter tasks with flexible criteria. " +
        "Returns matching tasks with full details. " +
        "Use this to find tasks by status, priority, project, tag, date range, or text search.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status",
            enum: ["pending", "completed", "cancelled"],
          },
          priority: {
            type: "number",
            description: "Filter by exact priority (1=urgent, 4=low)",
            enum: [1, 2, 3, 4],
          },
          projectId: {
            type: "string",
            description: "Filter by project ID",
          },
          tag: {
            type: "string",
            description: "Filter by tag name (exact match)",
          },
          search: {
            type: "string",
            description: "Search tasks by title or description text",
          },
          dueBefore: {
            type: "string",
            description: "Only tasks due before this ISO 8601 date (exclusive upper bound)",
          },
          dueAfter: {
            type: "string",
            description: "Only tasks due after this ISO 8601 date (exclusive lower bound)",
          },
          limit: {
            type: "number",
            description: "Maximum number of tasks to return (default 50, max 200)",
          },
        },
      },
    },
    async (args, ctx) => {
      const filter: TaskFilter = {};
      if (args.status) filter.status = args.status as TaskFilter["status"];
      if (args.priority) filter.priority = args.priority as number;
      if (args.projectId) filter.projectId = args.projectId as string;
      if (args.tag) filter.tag = args.tag as string;
      if (args.search) filter.search = args.search as string;
      if (args.dueBefore) filter.dueBefore = args.dueBefore as string;
      if (args.dueAfter) filter.dueAfter = args.dueAfter as string;

      const hasFilter = Object.keys(filter).length > 0;
      const allTasks = await ctx.taskService.list(hasFilter ? filter : undefined);

      const limit = Math.min(Math.max((args.limit as number) || 50, 1), 200);
      const sliced = allTasks.slice(0, limit);

      const summary = sliced.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate,
        projectId: t.projectId,
        recurrence: t.recurrence,
        remindAt: t.remindAt,
        tags: t.tags.map((tag) => tag.name),
      }));

      return JSON.stringify({
        tasks: summary,
        count: summary.length,
        totalMatched: allTasks.length,
      });
    },
  );
}
