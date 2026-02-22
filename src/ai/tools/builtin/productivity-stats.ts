/**
 * get_productivity_stats tool — returns streak, completion counts, and daily stats.
 * Uses the StatsService when available, falls back to task-based computation.
 */

import type { ToolRegistry } from "../registry.js";

export function registerProductivityStatsTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "get_productivity_stats",
      description:
        "Get productivity statistics including current streak, best streak, " +
        "daily completion counts, and task creation/completion trends over a date range. " +
        'Use when the user asks "how am I doing?", "show my stats", "what\'s my streak?", ' +
        'or "productivity report".',
      parameters: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "Start date as YYYY-MM-DD. Defaults to 30 days ago if not provided.",
          },
          endDate: {
            type: "string",
            description: "End date as YYYY-MM-DD. Defaults to today if not provided.",
          },
        },
      },
    },
    async (args, ctx) => {
      const now = new Date();
      const todayISO = now.toISOString().split("T")[0];

      const endDate = (args.endDate as string) || todayISO;
      const defaultStart = new Date(now);
      defaultStart.setDate(defaultStart.getDate() - 30);
      const startDate = (args.startDate as string) || defaultStart.toISOString().split("T")[0];

      // Use StatsService if available for accurate persisted data
      if (ctx.statsService) {
        const stats = await ctx.statsService.getStats(startDate, endDate);
        const currentStreak = await ctx.statsService.getCurrentStreak();
        const bestStreak = await ctx.statsService.getBestStreak(startDate, endDate);
        const todayStat = await ctx.statsService.getToday();

        const totalCompleted = stats.reduce((sum, s) => sum + s.tasksCompleted, 0);
        const totalCreated = stats.reduce((sum, s) => sum + s.tasksCreated, 0);
        const totalMinutes = stats.reduce((sum, s) => sum + s.minutesTracked, 0);
        const daysWithCompletions = stats.filter((s) => s.tasksCompleted > 0).length;
        const daysInRange = stats.length || 1;
        const avgCompletionsPerDay = Math.round((totalCompleted / daysInRange) * 10) / 10;

        // Daily breakdown (last 7 entries for brevity)
        const recentDays = stats.slice(-7).map((s) => ({
          date: s.date,
          completed: s.tasksCompleted,
          created: s.tasksCreated,
          minutesTracked: s.minutesTracked,
        }));

        return JSON.stringify({
          range: { startDate, endDate },
          currentStreak,
          bestStreak,
          today: {
            completed: todayStat.tasksCompleted,
            created: todayStat.tasksCreated,
            minutesTracked: todayStat.minutesTracked,
          },
          summary: {
            totalCompleted,
            totalCreated,
            totalMinutesTracked: totalMinutes,
            daysWithCompletions,
            daysInRange,
            avgCompletionsPerDay,
            netProgress: totalCompleted - totalCreated,
          },
          recentDays,
        });
      }

      // Fallback: compute from task data when StatsService is not available
      const completed = await ctx.taskService.list({ status: "completed" });
      const allTasks = await ctx.taskService.list({});

      const completedInRange = completed.filter(
        (t) =>
          t.completedAt &&
          t.completedAt.split("T")[0] >= startDate &&
          t.completedAt.split("T")[0] <= endDate,
      );

      const createdInRange = allTasks.filter(
        (t) =>
          t.createdAt &&
          t.createdAt.split("T")[0] >= startDate &&
          t.createdAt.split("T")[0] <= endDate,
      );

      // Calculate streak from completed tasks
      let currentStreak = 0;
      for (let i = 0; i < 30; i++) {
        const d = new Date(todayISO + "T00:00:00");
        d.setDate(d.getDate() - i);
        const dISO = d.toISOString().split("T")[0];
        const hasCompletion = completed.some(
          (t) => t.completedAt && t.completedAt.split("T")[0] === dISO,
        );
        if (hasCompletion) {
          currentStreak++;
        } else {
          if (i === 0) continue;
          break;
        }
      }

      const totalCompleted = completedInRange.length;
      const totalCreated = createdInRange.length;

      // Count days with completions
      const completionDates = new Set<string>();
      for (const t of completedInRange) {
        if (t.completedAt) completionDates.add(t.completedAt.split("T")[0]);
      }

      const daysInRange = Math.max(
        1,
        Math.ceil(
          (new Date(endDate + "T00:00:00").getTime() -
            new Date(startDate + "T00:00:00").getTime()) /
            86400000,
        ) + 1,
      );

      return JSON.stringify({
        range: { startDate, endDate },
        currentStreak,
        bestStreak: null,
        today: {
          completed: completed.filter(
            (t) => t.completedAt && t.completedAt.split("T")[0] === todayISO,
          ).length,
          created: allTasks.filter((t) => t.createdAt && t.createdAt.split("T")[0] === todayISO)
            .length,
          minutesTracked: null,
        },
        summary: {
          totalCompleted,
          totalCreated,
          totalMinutesTracked: null,
          daysWithCompletions: completionDates.size,
          daysInRange,
          avgCompletionsPerDay: Math.round((totalCompleted / daysInRange) * 10) / 10,
          netProgress: totalCompleted - totalCreated,
        },
        recentDays: null,
      });
    },
  );
}
