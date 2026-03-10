/**
 * weekly_review tool — generates a comprehensive weekly review with analytics.
 * Computes completion rates, task flow, streaks, accomplishments, and suggestions.
 */

import type { ToolRegistry } from "../registry.js";
import type { Task } from "../../../core/types.js";

const MAX_LIST_SIZE = 10;
const MAX_TITLE_LENGTH = 60;
const STREAK_MAX_DAYS = 30;

const _TIME_BUCKETS = ["morning", "afternoon", "evening", "night"] as const;
type TimeBucket = (typeof _TIME_BUCKETS)[number];

function truncTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH - 3) + "..." : title;
}

function isoDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getTimeBucket(hour: number): TimeBucket {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

function getLastMonday(): string {
  const now = new Date();
  const day = now.getDay();
  // If today is Monday, go back 7 days to get *last* Monday
  const diff = day === 0 ? 6 : day - 1;
  const daysBack = diff === 0 ? 7 : diff;
  now.setDate(now.getDate() - daysBack);
  return isoDate(now);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function registerWeeklyReviewTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "weekly_review",
      description:
        "Weekly review and analytics: completion rate, task flow, busiest day, " +
        "productive time of day, neglected projects, overdue tasks, streaks, " +
        "top accomplishments, and actionable suggestions for next week. " +
        'Use when the user says "weekly review", "how was my week?", "week in review", ' +
        'or "weekly summary".',
      parameters: {
        type: "object",
        properties: {
          weekStartDate: {
            type: "string",
            description:
              "Start date of the week to review as YYYY-MM-DD (should be a Monday). " +
              "Defaults to last Monday.",
          },
        },
      },
    },
    async (args, ctx) => {
      const weekStartStr = (args.weekStartDate as string) || getLastMonday();
      const weekStart = new Date(weekStartStr + "T00:00:00");
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const weekEndStr = isoDate(weekEnd);

      // Fetch all tasks
      const allTasks = await ctx.taskService.list({});
      const completedTasks = await ctx.taskService.list({ status: "completed" });
      const cancelledTasks = await ctx.taskService.list({ status: "cancelled" });

      // Filter to the 7-day window
      function inWeek(dateStr: string | null): boolean {
        if (!dateStr) return false;
        const d = dateStr.split("T")[0];
        return d >= weekStartStr && d <= weekEndStr;
      }

      const completedInWeek = completedTasks.filter((t) => inWeek(t.completedAt));
      const createdInWeek = allTasks.filter((t) => inWeek(t.createdAt));
      const cancelledInWeek = cancelledTasks.filter((t) => inWeek(t.updatedAt));

      // Completion rate
      const totalActionable = completedInWeek.length + cancelledInWeek.length;
      const plannedInWeek = createdInWeek.length;
      const completionRate =
        totalActionable > 0
          ? Math.round((completedInWeek.length / totalActionable) * 100)
          : plannedInWeek === 0
            ? 0
            : 0;

      // Task flow
      const taskFlow = {
        created: createdInWeek.length,
        completed: completedInWeek.length,
        cancelled: cancelledInWeek.length,
        net: completedInWeek.length - createdInWeek.length,
      };

      // Daily breakdown
      const dailyStats: {
        date: string;
        dayName: string;
        completed: number;
        created: number;
      }[] = [];

      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        const dStr = isoDate(d);
        const dayName = DAY_NAMES[d.getDay()];

        dailyStats.push({
          date: dStr,
          dayName,
          completed: completedInWeek.filter(
            (t) => t.completedAt && t.completedAt.split("T")[0] === dStr,
          ).length,
          created: createdInWeek.filter((t) => t.createdAt && t.createdAt.split("T")[0] === dStr)
            .length,
        });
      }

      // Busiest day
      const busiestDay = dailyStats.reduce(
        (best, day) => (day.completed > best.completed ? day : best),
        dailyStats[0],
      );

      // Most productive time of day
      const bucketCounts: Record<TimeBucket, number> = {
        morning: 0,
        afternoon: 0,
        evening: 0,
        night: 0,
      };

      for (const t of completedInWeek) {
        if (t.completedAt) {
          const hour = new Date(t.completedAt).getHours();
          bucketCounts[getTimeBucket(hour)]++;
        }
      }

      const productiveTime =
        completedInWeek.length > 0
          ? (Object.entries(bucketCounts).sort(([, a], [, b]) => b - a)[0][0] as TimeBucket)
          : null;

      // Neglected projects — projects with overdue tasks or no activity this week
      const projects = await ctx.projectService.list();
      const now = new Date();
      const todayStr = isoDate(now);

      const neglectedProjects: {
        id: string;
        name: string;
        overdueCount: number;
        reason: string;
      }[] = [];

      for (const project of projects) {
        if (project.archived) continue;

        const projectTasks = allTasks.filter((t) => t.projectId === project.id);
        const overdueTasks = projectTasks.filter(
          (t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < todayStr,
        );
        const hadActivity =
          projectTasks.some((t) => inWeek(t.completedAt)) ||
          projectTasks.some((t) => inWeek(t.createdAt));

        if (overdueTasks.length > 0) {
          neglectedProjects.push({
            id: project.id,
            name: project.name,
            overdueCount: overdueTasks.length,
            reason: `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`,
          });
        } else if (!hadActivity && projectTasks.some((t) => t.status === "pending")) {
          neglectedProjects.push({
            id: project.id,
            name: project.name,
            overdueCount: 0,
            reason: "No activity this week",
          });
        }
      }

      // Overdue tasks (as of now)
      const overdueTasks = allTasks
        .filter((t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < todayStr)
        .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));

      // Streak calculation
      let streakDays = 0;
      for (let i = 0; i < STREAK_MAX_DAYS; i++) {
        const d = new Date(todayStr + "T00:00:00");
        d.setDate(d.getDate() - i);
        const dStr = isoDate(d);
        const hasCompletion = completedTasks.some(
          (t) => t.completedAt && t.completedAt.split("T")[0] === dStr,
        );
        if (hasCompletion) {
          streakDays++;
        } else {
          if (i === 0) continue; // today might not have completions yet
          break;
        }
      }

      // Top accomplishments (highest priority completed tasks)
      const topAccomplishments = completedInWeek
        .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          title: truncTitle(t.title),
          priority: t.priority,
          completedAt: t.completedAt,
          projectId: t.projectId,
        }));

      // Suggestions
      const suggestions = generateSuggestions({
        taskFlow,
        completionRate,
        overdueTasks,
        neglectedProjects,
        busiestDay,
        productiveTime,
        dailyStats,
        streakDays,
      });

      return JSON.stringify({
        weekStartDate: weekStartStr,
        weekEndDate: weekEndStr,
        completionRate,
        taskFlow,
        dailyStats,
        busiestDay: busiestDay
          ? { date: busiestDay.date, dayName: busiestDay.dayName, completed: busiestDay.completed }
          : null,
        productiveTime,
        productiveTimeCounts: bucketCounts,
        neglectedProjects: neglectedProjects.slice(0, MAX_LIST_SIZE),
        overdue: {
          count: overdueTasks.length,
          tasks: overdueTasks.slice(0, MAX_LIST_SIZE).map((t) => ({
            id: t.id,
            title: truncTitle(t.title),
            priority: t.priority,
            dueDate: t.dueDate,
          })),
        },
        streak: {
          currentDays: streakDays,
          isActive: streakDays > 0,
        },
        topAccomplishments,
        suggestions,
      });
    },
  );
}

interface SuggestionInput {
  taskFlow: { created: number; completed: number; cancelled: number; net: number };
  completionRate: number;
  overdueTasks: Task[];
  neglectedProjects: { name: string; overdueCount: number }[];
  busiestDay: { dayName: string; completed: number } | undefined;
  productiveTime: TimeBucket | null;
  dailyStats: { dayName: string; completed: number }[];
  streakDays: number;
}

function generateSuggestions(input: SuggestionInput): string[] {
  const suggestions: string[] = [];

  if (input.overdueTasks.length > 0) {
    suggestions.push(
      `Tackle your ${input.overdueTasks.length} overdue task${input.overdueTasks.length > 1 ? "s" : ""} early in the week to clear the backlog.`,
    );
  }

  if (input.neglectedProjects.length > 0) {
    const names = input.neglectedProjects
      .slice(0, 3)
      .map((p) => p.name)
      .join(", ");
    suggestions.push(`Check in on neglected projects: ${names}.`);
  }

  if (input.taskFlow.created > input.taskFlow.completed && input.taskFlow.created > 0) {
    suggestions.push(
      "You created more tasks than you completed — consider being more selective about what you add.",
    );
  }

  if (input.productiveTime && input.busiestDay) {
    suggestions.push(
      `Schedule deep work during ${input.productiveTime} hours — that's when you're most productive.`,
    );
  }

  // Check for uneven distribution
  const completedCounts = input.dailyStats.map((d) => d.completed);
  const maxDay = Math.max(...completedCounts);
  const minDay = Math.min(...completedCounts);
  if (maxDay > 0 && minDay === 0 && completedCounts.filter((c) => c === 0).length >= 3) {
    suggestions.push("Try spreading your work more evenly across the week to avoid burnout.");
  }

  if (input.streakDays > 0) {
    suggestions.push(
      `Keep your ${input.streakDays}-day streak going — complete at least one task each day!`,
    );
  }

  // Cap at 4
  return suggestions.slice(0, 4);
}
