/**
 * AI tools for auto-scheduling tasks onto the timeblocking timeline.
 *
 * These tools are registered by the timeblocking plugin when AI is available.
 * They bridge the auto-scheduling engine with the AI assistant.
 */

import type { ToolDefinition, ToolExecutor } from "../types.js";
import type { TimeBlockStore } from "../../../plugins/builtin/timeblocking/store.js";
import {
  autoSchedule,
  applySchedule,
  type SchedulerSettings,
} from "../../../plugins/builtin/timeblocking/auto-scheduler.js";
import type { Task } from "../../../core/types.js";

interface ToolPair {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

/**
 * Build the auto-schedule AI tools.
 * Called by the timeblocking plugin to register tools with the AI system.
 */
export function buildAutoScheduleTools(
  store: TimeBlockStore,
  getSettings: () => {
    workDayStart: string;
    workDayEnd: string;
    defaultDurationMinutes: number;
    gridIntervalMinutes: number;
  },
): ToolPair[] {
  const tools: ToolPair[] = [];

  // ---------- auto_schedule_day ----------
  tools.push({
    definition: {
      name: "auto_schedule_day",
      description:
        "Automatically schedule pending tasks into available time gaps for a given day. " +
        "Can run in 'suggest' mode (returns proposal without changes) or 'auto' mode (creates blocks immediately).",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date to schedule for in YYYY-MM-DD format (required)",
          },
          mode: {
            type: "string",
            enum: ["suggest", "auto"],
            description:
              "Mode: 'suggest' returns a preview, 'auto' applies immediately (default: suggest)",
          },
          respectLocked: {
            type: "boolean",
            description: "Whether to preserve locked blocks (default: true)",
          },
        },
        required: ["date"],
      },
    },
    executor: async (args, ctx) => {
      const date = args.date as string;
      const mode = (args.mode as string) ?? "suggest";
      const respectLocked = (args.respectLocked as boolean) ?? true;

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return JSON.stringify({ error: "Invalid date format. Expected YYYY-MM-DD." });
      }

      // Get pending tasks
      let tasks: Task[] = [];
      if (ctx.taskService) {
        const allTasks = await ctx.taskService.list();
        tasks = allTasks.filter((t) => t.status === "pending");
      }

      if (tasks.length === 0) {
        return JSON.stringify({ message: "No pending tasks to schedule." });
      }

      // Get existing blocks
      let existingBlocks = store.listBlocks(date);
      if (respectLocked) {
        // Keep locked blocks as immovable; include all for gap calculation
      } else {
        // Only keep locked blocks; unlocked ones will be replaced
        existingBlocks = existingBlocks.filter((b) => b.locked);
      }

      // Filter out tasks that already have blocks on this date
      const scheduledTaskIds = new Set(existingBlocks.map((b) => b.taskId).filter(Boolean));
      tasks = tasks.filter((t) => !scheduledTaskIds.has(t.id));

      const pluginSettings = getSettings();
      const settings: SchedulerSettings = {
        workDayStart: pluginSettings.workDayStart,
        workDayEnd: pluginSettings.workDayEnd,
        gridIntervalMinutes: pluginSettings.gridIntervalMinutes,
        defaultDurationMinutes: pluginSettings.defaultDurationMinutes,
        bufferMinutes: 5,
      };

      const result = autoSchedule({
        tasks,
        existingBlocks,
        date,
        settings,
      });

      if (mode === "auto") {
        const ids = await applySchedule(result.proposed, store);
        return JSON.stringify(
          {
            applied: true,
            blocksCreated: ids.length,
            totalScheduledMinutes: result.totalScheduledMinutes,
            warnings: result.warnings,
            blocks: result.proposed.map((p, i) => ({
              id: ids[i],
              title: p.title,
              startTime: p.startTime,
              endTime: p.endTime,
            })),
          },
          null,
          2,
        );
      }

      // Suggest mode
      return JSON.stringify(
        {
          applied: false,
          proposed: result.proposed.map((p) => ({
            title: p.title,
            startTime: p.startTime,
            endTime: p.endTime,
            score: Math.round(p.score * 100) / 100,
          })),
          warnings: result.warnings,
          totalScheduledMinutes: result.totalScheduledMinutes,
          totalRequestedMinutes: result.totalRequestedMinutes,
          couldNotFit: result.warnings.filter((w) => w.reason.includes("No available")).length,
        },
        null,
        2,
      );
    },
  });

  // ---------- reschedule_day ----------
  tools.push({
    definition: {
      name: "reschedule_day",
      description:
        "Remove auto-scheduled (unlocked) blocks for a date and re-run auto-scheduling. " +
        "Useful when priorities have changed or new tasks were added.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date to reschedule in YYYY-MM-DD format (required)",
          },
          keepManual: {
            type: "boolean",
            description: "Whether to keep manually placed (locked) blocks (default: true)",
          },
        },
        required: ["date"],
      },
    },
    executor: async (args, ctx) => {
      const date = args.date as string;
      const keepManual = (args.keepManual as boolean) ?? true;

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return JSON.stringify({ error: "Invalid date format. Expected YYYY-MM-DD." });
      }

      // Remove unlocked blocks
      const existingBlocks = store.listBlocks(date);
      const toRemove = existingBlocks.filter((b) => (keepManual ? !b.locked : true));
      const removedCount = toRemove.length;

      for (const block of toRemove) {
        await store.deleteBlock(block.id);
      }

      // Remaining blocks (locked ones)
      const remainingBlocks = keepManual ? existingBlocks.filter((b) => b.locked) : [];

      // Get pending tasks
      let tasks: Task[] = [];
      if (ctx.taskService) {
        const allTasks = await ctx.taskService.list();
        tasks = allTasks.filter((t) => t.status === "pending");
      }

      // Filter out tasks already scheduled via remaining blocks
      const scheduledTaskIds = new Set(remainingBlocks.map((b) => b.taskId).filter(Boolean));
      tasks = tasks.filter((t) => !scheduledTaskIds.has(t.id));

      const pluginSettings = getSettings();
      const settings: SchedulerSettings = {
        workDayStart: pluginSettings.workDayStart,
        workDayEnd: pluginSettings.workDayEnd,
        gridIntervalMinutes: pluginSettings.gridIntervalMinutes,
        defaultDurationMinutes: pluginSettings.defaultDurationMinutes,
        bufferMinutes: 5,
      };

      const result = autoSchedule({
        tasks,
        existingBlocks: remainingBlocks,
        date,
        settings,
      });

      const ids = await applySchedule(result.proposed, store);

      return JSON.stringify(
        {
          removedBlocks: removedCount,
          createdBlocks: ids.length,
          totalScheduledMinutes: result.totalScheduledMinutes,
          warnings: result.warnings,
          blocks: result.proposed.map((p, i) => ({
            id: ids[i],
            title: p.title,
            startTime: p.startTime,
            endTime: p.endTime,
          })),
        },
        null,
        2,
      );
    },
  });

  return tools;
}
