/**
 * analyze_completion_patterns tool — mines completed task history to find
 * productivity patterns, recurring behaviors, and optimal work times.
 * Supports Issues #14 (Recurrent Life Automation) and #10 (Context-Aware Reminders).
 */

import type { ToolRegistry } from "../registry.js";

/** Normalize a title for grouping repeated tasks. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}

/** Map an average interval in days to a human-readable recurrence suggestion. */
function suggestRecurrence(avgDays: number): string {
  if (avgDays <= 1.5) return "daily";
  if (avgDays <= 4) return "every 3 days";
  if (avgDays <= 10) return "weekly";
  if (avgDays <= 18) return "every 2 weeks";
  if (avgDays <= 45) return "monthly";
  return "every 2 months";
}

export function registerAnalyzePatternsTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "analyze_completion_patterns",
      description:
        "Analyze completed task history to find productivity patterns. " +
        "Returns completion time distributions, most active tags, and " +
        "repeated tasks that may benefit from recurrence rules.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of days of history to analyze (default 90)",
          },
        },
      },
    },
    async (args, ctx) => {
      const days = Math.max(1, (args.days as number) || 90);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffISO = cutoff.toISOString();

      const completed = await ctx.taskService.list({ status: "completed" });
      const inWindow = completed.filter((t) => t.completedAt && t.completedAt >= cutoffISO);

      // Hour histogram (0-23)
      const byHour: Record<number, number> = {};
      for (let h = 0; h < 24; h++) byHour[h] = 0;

      // Weekday histogram (0=Sunday ... 6=Saturday)
      const byWeekday: Record<string, number> = {
        Sun: 0,
        Mon: 0,
        Tue: 0,
        Wed: 0,
        Thu: 0,
        Fri: 0,
        Sat: 0,
      };
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

      let totalCompletionHours = 0;
      let completionCount = 0;

      // Tag frequency
      const tagCounts = new Map<string, number>();

      for (const task of inWindow) {
        const completedDate = new Date(task.completedAt!);
        byHour[completedDate.getUTCHours()]++;
        byWeekday[dayNames[completedDate.getUTCDay()]]++;

        // Time-to-complete
        const createdDate = new Date(task.createdAt);
        const hours = (completedDate.getTime() - createdDate.getTime()) / (1000 * 60 * 60);
        if (hours >= 0) {
          totalCompletionHours += hours;
          completionCount++;
        }

        // Tag frequency
        for (const tag of task.tags) {
          tagCounts.set(tag.name, (tagCounts.get(tag.name) ?? 0) + 1);
        }
      }

      const avgCompletionHours =
        completionCount > 0 ? Math.round((totalCompletionHours / completionCount) * 10) / 10 : 0;

      // Top tags
      const topTags = Array.from(tagCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag, count]) => ({ tag, count }));

      // Repeated title detection
      const titleGroups = new Map<string, { originalTitle: string; completedDates: Date[] }>();
      for (const task of inWindow) {
        const normalized = normalizeTitle(task.title);
        if (!normalized) continue;
        const group = titleGroups.get(normalized);
        if (group) {
          group.completedDates.push(new Date(task.completedAt!));
        } else {
          titleGroups.set(normalized, {
            originalTitle: task.title,
            completedDates: [new Date(task.completedAt!)],
          });
        }
      }

      const repeatedPatterns: {
        title: string;
        count: number;
        avgIntervalDays: number;
        suggestedRecurrence: string;
      }[] = [];

      for (const [, group] of titleGroups) {
        if (group.completedDates.length < 3) continue;
        const sorted = group.completedDates.sort((a, b) => a.getTime() - b.getTime());
        let totalInterval = 0;
        for (let i = 1; i < sorted.length; i++) {
          totalInterval += (sorted[i].getTime() - sorted[i - 1].getTime()) / (1000 * 60 * 60 * 24);
        }
        const avgInterval = Math.round((totalInterval / (sorted.length - 1)) * 10) / 10;
        repeatedPatterns.push({
          title: group.originalTitle,
          count: group.completedDates.length,
          avgIntervalDays: avgInterval,
          suggestedRecurrence: suggestRecurrence(avgInterval),
        });
      }

      repeatedPatterns.sort((a, b) => b.count - a.count);

      return JSON.stringify({
        totalCompleted: inWindow.length,
        daysAnalyzed: days,
        byHour,
        byWeekday,
        avgCompletionHours,
        topTags,
        repeatedPatterns,
      });
    },
  );
}
