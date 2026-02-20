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

export function registerCheckOvercommitmentTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "check_overcommitment",
      description:
        "Quick check if a specific date is overloaded with tasks. " +
        "Use proactively when creating or scheduling tasks with due dates.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "ISO date to check (YYYY-MM-DD). Defaults to today.",
          },
        },
      },
    },
    async (args, ctx) => {
      const now = new Date();
      const todayISO = now.toISOString().split("T")[0];
      const targetDate = (args.date as string) || todayISO;

      const pending = await ctx.taskService.list({ status: "pending" });

      // Count tasks due on the target date
      const tasksOnDate = pending.filter(
        (t) => t.dueDate && t.dueDate.split("T")[0] === targetDate,
      );

      // Count overdue tasks
      const overdue = pending.filter((t) => t.dueDate && t.dueDate.split("T")[0] < todayISO);

      // Calculate priority weight for the target date
      let priorityWeight = 0;
      for (const task of tasksOnDate) {
        priorityWeight += PRIORITY_WEIGHT[task.priority ?? 4] ?? 1;
      }

      const isOverloaded =
        tasksOnDate.length > OVERLOADED_TASK_THRESHOLD ||
        priorityWeight > OVERLOADED_WEIGHT_THRESHOLD;

      // Find a lighter day to suggest if overloaded
      let suggestion: string | null = null;
      if (isOverloaded) {
        // Look at 7 days around the target to find a lighter day
        const targetD = new Date(targetDate + "T00:00:00");
        let lightest: { date: string; count: number } | null = null;

        for (let i = 1; i <= 7; i++) {
          const d = new Date(targetD);
          d.setDate(d.getDate() + i);
          const dateStr = d.toISOString().split("T")[0];
          const count = pending.filter(
            (t) => t.dueDate && t.dueDate.split("T")[0] === dateStr,
          ).length;
          if (!lightest || count < lightest.count) {
            lightest = { date: dateStr, count };
          }
        }

        const dayNames = [
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ];
        const targetDay = dayNames[targetD.getDay()];

        if (lightest && lightest.count < tasksOnDate.length) {
          const lighterD = new Date(lightest.date + "T00:00:00");
          const lighterDay = dayNames[lighterD.getDay()];
          suggestion =
            `You have ${tasksOnDate.length} tasks due ${targetDay}. ` +
            `Consider spreading some to ${lighterDay} (only ${lightest.count} task${lightest.count === 1 ? "" : "s"}).`;
        } else {
          suggestion = `You have ${tasksOnDate.length} tasks due ${targetDay}. Consider rescheduling some tasks.`;
        }
      }

      return JSON.stringify({
        date: targetDate,
        taskCount: tasksOnDate.length,
        priorityWeight,
        isOverloaded,
        overdue: overdue.length,
        suggestion,
      });
    },
  );
}

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
      const avgPerDay = daysWithTasks > 0 ? Math.round((totalTasks / daysWithTasks) * 10) / 10 : 0;

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
