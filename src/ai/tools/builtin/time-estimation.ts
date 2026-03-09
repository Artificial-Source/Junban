/**
 * Built-in AI tools for time estimation and tracking analysis.
 * Registers: estimate_task_duration, time_tracking_summary
 */

import type { ToolRegistry } from "../registry.js";

export function registerTimeEstimationTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "estimate_task_duration",
      description:
        "Suggest an estimated duration for a task based on similar completed tasks. Analyzes titles, priorities, and tags of past completed tasks to find patterns.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to estimate duration for",
          },
        },
        required: ["taskId"],
      },
    },
    async (args, ctx) => {
      const task = await ctx.taskService.get(args.taskId as string);
      if (!task) {
        return JSON.stringify({ success: false, error: "Task not found" });
      }

      // Get all completed tasks with actual time tracked
      const allTasks = await ctx.taskService.list({ status: "completed" });
      const tasksWithTime = allTasks.filter((t) => t.actualMinutes != null && t.actualMinutes > 0);

      if (tasksWithTime.length === 0) {
        return JSON.stringify({
          success: true,
          taskId: task.id,
          taskTitle: task.title,
          suggestion: null,
          message:
            "No completed tasks with time tracking data found. Complete some tasks with time tracking to get estimates.",
        });
      }

      // Score similarity: matching tags, priority, and title words
      const taskWords = new Set(task.title.toLowerCase().split(/\s+/));
      const taskTagNames = new Set(task.tags.map((t) => t.name));

      const scored = tasksWithTime.map((t) => {
        let score = 0;

        // Matching tags (strongest signal)
        const matchedTags = t.tags.filter((tag) => taskTagNames.has(tag.name));
        score += matchedTags.length * 3;

        // Same priority
        if (t.priority === task.priority && task.priority !== null) {
          score += 2;
        }

        // Title word overlap
        const tWords = t.title.toLowerCase().split(/\s+/);
        for (const w of tWords) {
          if (taskWords.has(w) && w.length > 2) score += 1;
        }

        return { task: t, score };
      });

      // Filter to tasks with some similarity
      const similar = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

      if (similar.length === 0) {
        // Fall back to average of all tracked tasks
        const avg = Math.round(
          tasksWithTime.reduce((sum, t) => sum + t.actualMinutes!, 0) / tasksWithTime.length,
        );
        return JSON.stringify({
          success: true,
          taskId: task.id,
          taskTitle: task.title,
          suggestion: avg,
          confidence: "low",
          basedOn: tasksWithTime.length,
          message: `No similar tasks found. Based on average of all ${tasksWithTime.length} tracked tasks: ${avg} minutes.`,
        });
      }

      // Use top similar tasks (up to 5) for estimate
      const top = similar.slice(0, 5);
      const avgMinutes = Math.round(
        top.reduce((sum, s) => sum + s.task.actualMinutes!, 0) / top.length,
      );

      return JSON.stringify({
        success: true,
        taskId: task.id,
        taskTitle: task.title,
        suggestion: avgMinutes,
        confidence: top.length >= 3 ? "high" : "medium",
        basedOn: top.length,
        similarTasks: top.map((s) => ({
          title: s.task.title,
          actualMinutes: s.task.actualMinutes,
          similarity: s.score,
        })),
        message: `Estimated ${avgMinutes} minutes based on ${top.length} similar completed tasks.`,
      });
    },
  );

  registry.register(
    {
      name: "time_tracking_summary",
      description:
        "Show estimated vs actual time accuracy stats. Analyzes all tasks with both estimated and actual minutes to reveal estimation patterns.",
      parameters: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Optional project ID to filter by. Omit for all tasks.",
          },
        },
        required: [],
      },
    },
    async (args, ctx) => {
      const allTasks = await ctx.taskService.list({ status: "completed" });
      let tasks = allTasks.filter(
        (t) =>
          t.estimatedMinutes != null &&
          t.estimatedMinutes > 0 &&
          t.actualMinutes != null &&
          t.actualMinutes > 0,
      );

      if (args.projectId) {
        tasks = tasks.filter((t) => t.projectId === (args.projectId as string));
      }

      if (tasks.length === 0) {
        return JSON.stringify({
          success: true,
          message:
            "No tasks found with both estimated and actual time. Track time on estimated tasks to see accuracy stats.",
          totalTasks: 0,
        });
      }

      let totalEstimated = 0;
      let totalActual = 0;
      let overEstimated = 0;
      let underEstimated = 0;
      let accurate = 0;

      const ratios: number[] = [];

      for (const t of tasks) {
        const est = t.estimatedMinutes!;
        const act = t.actualMinutes!;
        totalEstimated += est;
        totalActual += act;

        const ratio = act / est;
        ratios.push(ratio);

        // Within 20% = accurate
        if (ratio >= 0.8 && ratio <= 1.2) {
          accurate++;
        } else if (ratio < 0.8) {
          overEstimated++;
        } else {
          underEstimated++;
        }
      }

      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const accuracyPercent = Math.round((accurate / tasks.length) * 100);

      return JSON.stringify({
        success: true,
        totalTasks: tasks.length,
        totalEstimatedMinutes: totalEstimated,
        totalActualMinutes: totalActual,
        averageAccuracyRatio: Math.round(avgRatio * 100) / 100,
        accuracyPercent,
        overEstimated,
        underEstimated,
        accurate,
        message: `Across ${tasks.length} tasks: ${accuracyPercent}% estimated within 20% accuracy. Average ratio (actual/estimated): ${(avgRatio * 100).toFixed(0)}%. Total estimated: ${totalEstimated}m, actual: ${totalActual}m.`,
      });
    },
  );
}
