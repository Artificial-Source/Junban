/**
 * get_energy_recommendations tool — classifies pending tasks by estimated
 * effort level for energy-aware planning.
 * Supports Issue #13 (Energy-Aware Planning).
 */

import type { ToolRegistry } from "../registry.js";
import type { Task } from "../../../core/types.js";

type EnergyLevel = "low" | "medium" | "high";

const QUICK_WIN_MINUTES = 10;
const DEEP_WORK_MINUTES = 45;
const QUICK_WIN_WORD_THRESHOLD = 8;

interface ClassifiedTask {
  id: string;
  title: string;
  priority: number | null;
  dueDate: string | null;
  category: "quick_win" | "deep_work";
  estimatedMinutes: number;
}

/** Classify a task as quick win or deep work based on heuristics. */
function classifyTask(task: Task, hasSubtasks: boolean): ClassifiedTask {
  const wordCount = task.title.trim().split(/\s+/).length;
  const isHighPriority = task.priority === 1 || task.priority === 2;
  const hasDescription = !!task.description && task.description.trim().length > 0;

  const isDeepWork =
    wordCount > QUICK_WIN_WORD_THRESHOLD ||
    hasSubtasks ||
    isHighPriority ||
    hasDescription;

  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    dueDate: task.dueDate,
    category: isDeepWork ? "deep_work" : "quick_win",
    estimatedMinutes: isDeepWork ? DEEP_WORK_MINUTES : QUICK_WIN_MINUTES,
  };
}

export function registerEnergyRecommendationsTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "get_energy_recommendations",
      description:
        "Get task recommendations based on available time and energy level. " +
        "Classifies pending tasks as quick wins or deep work, " +
        "then recommends a set that fits the user's current capacity.",
      parameters: {
        type: "object",
        properties: {
          available_minutes: {
            type: "number",
            description:
              "Minutes available to work (default 60)",
          },
          energy_level: {
            type: "string",
            description: "Current energy level",
            enum: ["low", "medium", "high"],
          },
        },
      },
    },
    async (args, ctx) => {
      const availableMinutes = Math.max(5, (args.available_minutes as number) || 60);
      const energyLevel = ((args.energy_level as string) || "medium") as EnergyLevel;

      const pending = await ctx.taskService.list({ status: "pending" });

      // Determine which tasks have subtasks
      const parentIds = new Set(
        pending.filter((t) => t.parentId).map((t) => t.parentId!),
      );

      const classified = pending
        .filter((t) => !t.parentId) // Only top-level tasks
        .map((t) => classifyTask(t, parentIds.has(t.id)));

      const quickWins = classified.filter((t) => t.category === "quick_win");
      const deepWork = classified.filter((t) => t.category === "deep_work");

      // Sort each group: due-date tasks first (soonest first), then by priority
      const sortTasks = (tasks: ClassifiedTask[]): ClassifiedTask[] =>
        [...tasks].sort((a, b) => {
          // Tasks with due dates come first
          if (a.dueDate && !b.dueDate) return -1;
          if (!a.dueDate && b.dueDate) return 1;
          if (a.dueDate && b.dueDate) {
            if (a.dueDate < b.dueDate) return -1;
            if (a.dueDate > b.dueDate) return 1;
          }
          // Then by priority (lower number = higher priority)
          const pa = a.priority ?? 5;
          const pb = b.priority ?? 5;
          return pa - pb;
        });

      const sortedQuickWins = sortTasks(quickWins);
      const sortedDeepWork = sortTasks(deepWork);

      // Build ordered recommendation list based on energy level
      let ordered: ClassifiedTask[];
      switch (energyLevel) {
        case "low":
          ordered = sortedQuickWins;
          break;
        case "high":
          ordered = [...sortedDeepWork, ...sortedQuickWins];
          break;
        case "medium":
        default:
          ordered = [...sortedQuickWins, ...sortedDeepWork];
          break;
      }

      // Trim to fit available minutes
      const recommended: ClassifiedTask[] = [];
      let totalMinutes = 0;
      for (const task of ordered) {
        if (totalMinutes + task.estimatedMinutes > availableMinutes) {
          // If we haven't added anything yet and the first task exceeds budget,
          // include it anyway so we always return at least one suggestion
          if (recommended.length === 0) {
            recommended.push(task);
            totalMinutes += task.estimatedMinutes;
          }
          break;
        }
        recommended.push(task);
        totalMinutes += task.estimatedMinutes;
      }

      return JSON.stringify({
        energyLevel,
        availableMinutes,
        quickWins: sortedQuickWins.slice(0, 10),
        deepWork: sortedDeepWork.slice(0, 10),
        recommended,
        estimatedMinutes: totalMinutes,
      });
    },
  );
}
