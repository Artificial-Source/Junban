/**
 * plan_my_day + daily_review tools — morning briefing and end-of-day review.
 * Supports Backlog items A-32 (Morning Briefing) and A-33 (Daily Review).
 */

import type { ToolRegistry } from "../registry.js";
import type { Task } from "../../../core/types.js";

const PRIORITY_WEIGHT: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1 };
const OVERLOADED_TASK_THRESHOLD = 5;
const OVERLOADED_WEIGHT_THRESHOLD = 12;
const LIGHT_TASK_THRESHOLD = 2;
const QUICK_WIN_WORD_THRESHOLD = 8;
const MAX_LIST_SIZE = 10;
const MAX_TITLE_LENGTH = 60;
const STREAK_MAX_DAYS = 30;
const PRODUCTIVITY_MIN_DAYS = 5;

function truncTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH - 3) + "..." : title;
}

function isoDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function isSameDay(dateStr: string, targetISO: string): boolean {
  return dateStr.split("T")[0] === targetISO;
}

function classifyTask(task: Task): "quick_win" | "deep_work" {
  const wordCount = task.title.trim().split(/\s+/).length;
  const isHighPriority = task.priority === 1 || task.priority === 2;
  const hasDescription = !!task.description && task.description.trim().length > 0;
  return wordCount > QUICK_WIN_WORD_THRESHOLD || isHighPriority || hasDescription
    ? "deep_work"
    : "quick_win";
}

function taskSummary(task: Task) {
  return {
    id: task.id,
    title: truncTitle(task.title),
    priority: task.priority,
    dueDate: task.dueDate,
    tags: task.tags ?? [],
  };
}

function computePriorityWeight(tasks: Task[]): number {
  let w = 0;
  for (const t of tasks) w += PRIORITY_WEIGHT[t.priority ?? 4] ?? 1;
  return w;
}

function assessWorkload(count: number, weight: number): "light" | "normal" | "heavy" {
  if (count > OVERLOADED_TASK_THRESHOLD || weight > OVERLOADED_WEIGHT_THRESHOLD) return "heavy";
  if (count <= LIGHT_TASK_THRESHOLD) return "light";
  return "normal";
}

// ── plan_my_day ─────────────────────────────────────────────────────────────

export function registerPlanMyDayTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "plan_my_day",
      description:
        "Morning briefing: today's tasks, overdue items, focus blocks ordered by energy, " +
        "reminders, and productivity insights from completion history. " +
        'Use when the user says "plan my day", "morning briefing", or "what should I work on?".',
      parameters: {
        type: "object",
        properties: {
          energy_level: {
            type: "string",
            description: "Current energy level (default medium)",
            enum: ["low", "medium", "high"],
          },
        },
      },
    },
    async (args, ctx) => {
      const energyLevel = ((args.energy_level as string) || "medium") as "low" | "medium" | "high";
      const now = new Date();
      const todayISO = isoDate(now);

      // Fetch pending tasks and recently completed tasks
      const pending = await ctx.taskService.list({ status: "pending" });
      const completed = await ctx.taskService.list({ status: "completed" });

      // Filter completed to last 30 days
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoISO = isoDate(thirtyDaysAgo);
      const recentCompleted = completed.filter(
        (t) => t.completedAt && t.completedAt.split("T")[0] >= thirtyDaysAgoISO,
      );

      // Categorize pending tasks
      const todaysTasks = pending
        .filter((t) => t.dueDate && isSameDay(t.dueDate, todayISO))
        .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));

      const overdueTasks = pending
        .filter((t) => t.dueDate && t.dueDate.split("T")[0] < todayISO)
        .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));

      const unscheduledHighPriority = pending
        .filter((t) => !t.dueDate && (t.priority === 1 || t.priority === 2))
        .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));

      // Workload assessment
      const totalToday = todaysTasks.length;
      const priorityWeight = computePriorityWeight(todaysTasks);
      const assessment = assessWorkload(totalToday, priorityWeight);

      // Focus blocks
      const allActionable = [...todaysTasks, ...overdueTasks];
      const quickWins = allActionable.filter((t) => classifyTask(t) === "quick_win");
      const deepWork = allActionable.filter((t) => classifyTask(t) === "deep_work");

      let orderedBlocks: { type: "quick_win" | "deep_work"; tasks: typeof allActionable }[];
      switch (energyLevel) {
        case "low":
          orderedBlocks = [{ type: "quick_win", tasks: quickWins }];
          break;
        case "high":
          orderedBlocks = [
            { type: "deep_work", tasks: deepWork },
            { type: "quick_win", tasks: quickWins },
          ];
          break;
        case "medium":
        default:
          orderedBlocks = [
            { type: "quick_win", tasks: quickWins },
            { type: "deep_work", tasks: deepWork },
          ];
          break;
      }

      const focusBlocks = {
        order: energyLevel,
        blocks: orderedBlocks
          .filter((b) => b.tasks.length > 0)
          .map((b) => ({
            type: b.type,
            tasks: b.tasks.slice(0, MAX_LIST_SIZE).map(taskSummary),
          })),
      };

      // Reminders due today
      const remindersToday = pending
        .filter((t) => t.remindAt && isSameDay(t.remindAt, todayISO))
        .map((t) => ({
          id: t.id,
          title: truncTitle(t.title),
          remindAt: t.remindAt,
        }))
        .slice(0, MAX_LIST_SIZE);

      // Productivity context from 30-day history
      let productivityContext: {
        peakHour: number | null;
        peakDay: string | null;
        recentCompletionRate: number;
        insight: string;
      } | null = null;

      if (recentCompleted.length >= PRODUCTIVITY_MIN_DAYS) {
        // Peak hour
        const hourCounts: Record<number, number> = {};
        const dayCounts: Record<string, number> = {};
        const dayNames = [
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ];

        for (const t of recentCompleted) {
          if (t.completedAt) {
            const d = new Date(t.completedAt);
            const hour = d.getHours();
            hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
            const dayName = dayNames[d.getDay()];
            dayCounts[dayName] = (dayCounts[dayName] ?? 0) + 1;
          }
        }

        const peakHour =
          Object.keys(hourCounts).length > 0
            ? Number(Object.entries(hourCounts).sort(([, a], [, b]) => b - a)[0][0])
            : null;

        const peakDay =
          Object.keys(dayCounts).length > 0
            ? Object.entries(dayCounts).sort(([, a], [, b]) => b - a)[0][0]
            : null;

        // Recent completion rate (tasks completed per day over last 30 days)
        const daysInRange = Math.min(
          30,
          Math.ceil((now.getTime() - thirtyDaysAgo.getTime()) / 86400000),
        );
        const recentCompletionRate =
          daysInRange > 0 ? Math.round((recentCompleted.length / daysInRange) * 10) / 10 : 0;

        const insights: string[] = [];
        if (peakHour !== null) {
          const hourStr =
            peakHour === 0
              ? "12 AM"
              : peakHour < 12
                ? `${peakHour} AM`
                : peakHour === 12
                  ? "12 PM"
                  : `${peakHour - 12} PM`;
          insights.push(`Most productive around ${hourStr}`);
        }
        if (peakDay) insights.push(`most active on ${peakDay}s`);

        productivityContext = {
          peakHour,
          peakDay,
          recentCompletionRate,
          insight: insights.join(", ") || "Keep building your completion history for insights.",
        };
      }

      // Greeting
      const hour = now.getHours();
      const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

      return JSON.stringify({
        date: todayISO,
        greeting,
        todaysTasks: todaysTasks.slice(0, MAX_LIST_SIZE).map((t) => ({
          ...taskSummary(t),
          daysOverdue: 0,
        })),
        overdueTasks: overdueTasks.slice(0, MAX_LIST_SIZE).map((t) => ({
          ...taskSummary(t),
          daysOverdue: (() => {
            const dueDateStr = t.dueDate!.split("T")[0];
            const [dy, dm, dd] = dueDateStr.split("-").map(Number);
            const [ty, tm, td] = todayISO.split("-").map(Number);
            return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
          })(),
        })),
        unscheduledHighPriority: unscheduledHighPriority.slice(0, MAX_LIST_SIZE).map(taskSummary),
        workload: {
          totalToday,
          priorityWeight,
          assessment,
          overdueCount: overdueTasks.length,
        },
        focusBlocks,
        remindersToday,
        productivityContext,
      });
    },
  );
}

// ── daily_review ────────────────────────────────────────────────────────────

export function registerDailyReviewTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "daily_review",
      description:
        "End-of-day review: completion stats, streaks, carried-over tasks, " +
        "tomorrow preview, and improvement suggestions. " +
        'Use when the user says "review my day", "daily review", or "how did I do today?".',
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "ISO date to review (YYYY-MM-DD). Defaults to today.",
          },
        },
      },
    },
    async (args, ctx) => {
      const now = new Date();
      const todayISO = isoDate(now);
      const targetDate = (args.date as string) || todayISO;

      // Fetch all tasks
      const allTasks = await ctx.taskService.list({});
      const completed = await ctx.taskService.list({ status: "completed" });

      // Tasks completed on target date
      const completedToday = completed.filter(
        (t) => t.completedAt && isSameDay(t.completedAt, targetDate),
      );

      // Tasks carried over (due on target date but still pending)
      const pending = allTasks.filter((t) => t.status === "pending");
      const carriedOver = pending.filter((t) => t.dueDate && isSameDay(t.dueDate, targetDate));

      // Tasks created on target date
      const createdToday = allTasks.filter(
        (t) => t.createdAt && isSameDay(t.createdAt, targetDate),
      );

      // Stats
      const completedCount = completedToday.length;
      const plannedCount = completedCount + carriedOver.length;
      const completionRate =
        plannedCount > 0 ? Math.round((completedCount / plannedCount) * 100) : 0;
      const createdCount = createdToday.length;
      const netProgress = completedCount - createdCount;

      // Streak: walk backwards up to 30 days
      let streakDays = 0;
      for (let i = 0; i < STREAK_MAX_DAYS; i++) {
        const d = new Date(targetDate + "T00:00:00");
        d.setDate(d.getDate() - i);
        const dISO = isoDate(d);
        const hasCompletion = completed.some(
          (t) => t.completedAt && isSameDay(t.completedAt, dISO),
        );
        if (hasCompletion) {
          streakDays++;
        } else {
          // Day 0 (target date) can be empty if reviewing mid-day
          if (i === 0) continue;
          break;
        }
      }

      // Tomorrow preview
      const tomorrowD = new Date(targetDate + "T00:00:00");
      tomorrowD.setDate(tomorrowD.getDate() + 1);
      const tomorrowISO = isoDate(tomorrowD);
      const tomorrowTasks = pending
        .filter((t) => t.dueDate && isSameDay(t.dueDate, tomorrowISO))
        .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
      const tomorrowWeight = computePriorityWeight(tomorrowTasks);

      // Overdue (as of target date)
      const overdueTasks = pending.filter((t) => t.dueDate && t.dueDate.split("T")[0] < targetDate);

      // Suggestions
      const suggestions: string[] = [];
      if (carriedOver.length > 0) {
        suggestions.push(
          `${carriedOver.length} task${carriedOver.length > 1 ? "s" : ""} carried over — consider rescheduling or breaking them down.`,
        );
      }
      if (overdueTasks.length > 0) {
        suggestions.push(
          `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""} need attention.`,
        );
      }
      const unscheduledHighP = pending.filter(
        (t) => !t.dueDate && (t.priority === 1 || t.priority === 2),
      );
      if (unscheduledHighP.length > 0) {
        suggestions.push(
          `${unscheduledHighP.length} high-priority task${unscheduledHighP.length > 1 ? "s" : ""} have no due date.`,
        );
      }
      const tomorrowAssessment = assessWorkload(tomorrowTasks.length, tomorrowWeight);
      if (tomorrowAssessment === "heavy") {
        suggestions.push("Tomorrow looks heavy — consider moving some tasks to lighter days.");
      }

      return JSON.stringify({
        date: targetDate,
        completed: completedToday.slice(0, MAX_LIST_SIZE).map(taskSummary),
        carriedOver: carriedOver.slice(0, MAX_LIST_SIZE).map(taskSummary),
        created: createdToday.slice(0, MAX_LIST_SIZE).map(taskSummary),
        stats: {
          completedCount,
          plannedCount,
          completionRate,
          createdCount,
          netProgress,
        },
        streak: {
          currentDays: streakDays,
          isActive: streakDays > 0,
        },
        tomorrow: {
          taskCount: tomorrowTasks.length,
          tasks: tomorrowTasks.slice(0, MAX_LIST_SIZE).map(taskSummary),
          priorityWeight: tomorrowWeight,
          assessment: tomorrowAssessment,
        },
        suggestions,
      });
    },
  );
}
