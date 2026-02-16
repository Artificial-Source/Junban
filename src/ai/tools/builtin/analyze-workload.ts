/**
 * analyze_workload tool — analyzes task distribution across upcoming days
 * to prevent overload and support smart scheduling.
 * Supports Issue #11 (Smart Scheduling).
 */

import type { ToolRegistry } from "../registry.js";

const PRIORITY_WEIGHT: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1 };
const OVERLOADED_TASK_THRESHOLD = 5;
const OVERLOADED_WEIGHT_THRESHOLD = 12;
const LIGHT_TASK_THRESHOLD = 2;

export function registerAnalyzeWorkloadTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "analyze_workload",
      description:
        "Analyze task distribution across upcoming days. " +
        "Returns per-day task counts, priority weights, overloaded/light days, " +
        "overdue tasks, and unscheduled task counts. Use this for smart scheduling.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of days ahead to analyze (default 14)",
          },
        },
      },
    },
    async (args, ctx) => {
      const days = Math.max(1, (args.days as number) || 14);
      const now = new Date();
      const todayISO = now.toISOString().split("T")[0];
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

      const pending = await ctx.taskService.list({ status: "pending" });

      // Build day buckets
      const dayBuckets: {
        date: string;
        dayOfWeek: string;
        tasks: { id: string; title: string; priority: number | null }[];
        priorityWeight: number;
      }[] = [];

      for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split("T")[0];
        dayBuckets.push({
          date: dateStr,
          dayOfWeek: dayNames[d.getDay()],
          tasks: [],
          priorityWeight: 0,
        });
      }

      const unscheduled: { id: string; title: string; priority: number | null }[] = [];
      const overdue: { id: string; title: string; dueDate: string; priority: number | null }[] = [];

      for (const task of pending) {
        if (!task.dueDate) {
          unscheduled.push({
            id: task.id,
            title: task.title,
            priority: task.priority,
          });
          continue;
        }

        const taskDate = task.dueDate.split("T")[0];

        if (taskDate < todayISO) {
          overdue.push({
            id: task.id,
            title: task.title,
            dueDate: task.dueDate,
            priority: task.priority,
          });
          continue;
        }

        const bucket = dayBuckets.find((b) => b.date === taskDate);
        if (bucket) {
          bucket.tasks.push({
            id: task.id,
            title: task.title,
            priority: task.priority,
          });
          bucket.priorityWeight += PRIORITY_WEIGHT[task.priority ?? 4] ?? 1;
        }
      }

      // Format output
      const formattedDays = dayBuckets.map((b) => ({
        date: b.date,
        dayOfWeek: b.dayOfWeek,
        taskCount: b.tasks.length,
        priorityWeight: b.priorityWeight,
        isOverloaded:
          b.tasks.length > OVERLOADED_TASK_THRESHOLD ||
          b.priorityWeight > OVERLOADED_WEIGHT_THRESHOLD,
        isLight: b.tasks.length < LIGHT_TASK_THRESHOLD,
        tasks: b.tasks.map((t) => ({
          id: t.id,
          title: t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title,
          priority: t.priority,
        })),
      }));

      const taskCounts = formattedDays.map((d) => d.taskCount);
      const totalTasks = taskCounts.reduce((a, b) => a + b, 0);
      const daysWithTasks = taskCounts.filter((c) => c > 0).length;
      const avgPerDay =
        daysWithTasks > 0
          ? Math.round((totalTasks / daysWithTasks) * 10) / 10
          : 0;

      const busiestDay = formattedDays.reduce(
        (best, d) => (d.taskCount > best.taskCount ? d : best),
        formattedDays[0],
      );
      const lightestDay = formattedDays.reduce(
        (best, d) => (d.taskCount < best.taskCount ? d : best),
        formattedDays[0],
      );

      const highPriorityUnscheduled = unscheduled.filter(
        (t) => t.priority === 1 || t.priority === 2,
      );

      return JSON.stringify({
        days: formattedDays,
        unscheduled: {
          count: unscheduled.length,
          highPriority: highPriorityUnscheduled.length,
        },
        overdue: {
          count: overdue.length,
          tasks: overdue.slice(0, 10),
        },
        summary: {
          avgPerDay,
          busiestDay: busiestDay
            ? { date: busiestDay.date, taskCount: busiestDay.taskCount }
            : null,
          lightestDay: lightestDay
            ? { date: lightestDay.date, taskCount: lightestDay.taskCount }
            : null,
        },
      });
    },
  );
}
