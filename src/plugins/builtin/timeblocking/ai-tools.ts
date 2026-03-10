/**
 * AI tools for the timeblocking plugin.
 * Registers tools that let the AI assistant manage time blocks.
 */

import type { TimeBlockStore } from "./store.js";
import type { ToolDefinition, ToolExecutor } from "../../../ai/tools/types.js";
import { isOverlapping } from "./slot-helpers.js";

interface ToolPair {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

function parseTime(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function buildTimeblockingTools(
  store: TimeBlockStore,
  getSettings: () => { workDayStart: string; workDayEnd: string; defaultDurationMinutes: number },
): ToolPair[] {
  const tools: ToolPair[] = [];

  // 1. List blocks
  tools.push({
    definition: {
      name: "timeblocking_list_blocks",
      description: "List time blocks for a date or date range. Returns block titles, times, and linked tasks.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date in YYYY-MM-DD format" },
          startDate: { type: "string", description: "Range start date (YYYY-MM-DD). Use with endDate instead of date." },
          endDate: { type: "string", description: "Range end date (YYYY-MM-DD). Use with startDate." },
        },
      },
    },
    executor: async (args) => {
      const date = args.date as string | undefined;
      const startDate = args.startDate as string | undefined;
      const endDate = args.endDate as string | undefined;

      let blocks;
      if (startDate && endDate) {
        blocks = store.listBlocksInRange(startDate, endDate);
      } else if (date) {
        blocks = store.listBlocks(date);
      } else {
        blocks = store.listBlocks();
      }

      const result = blocks.map((b) => ({
        id: b.id,
        title: b.title,
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        taskId: b.taskId ?? null,
        locked: b.locked,
        recurrence: b.recurrenceRule ?? null,
      }));

      return JSON.stringify(result, null, 2);
    },
  });

  // 2. Create block
  tools.push({
    definition: {
      name: "timeblocking_create_block",
      description: "Create a new time block on the timeline.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Block title (required)" },
          date: { type: "string", description: "Date in YYYY-MM-DD format (required)" },
          startTime: { type: "string", description: "Start time in HH:MM format (required)" },
          endTime: { type: "string", description: "End time in HH:MM format (required)" },
          taskId: { type: "string", description: "Optional task ID to link" },
        },
        required: ["title", "date", "startTime", "endTime"],
      },
    },
    executor: async (args) => {
      const block = await store.createBlock({
        title: args.title as string,
        date: args.date as string,
        startTime: args.startTime as string,
        endTime: args.endTime as string,
        taskId: args.taskId as string | undefined,
        locked: false,
      });
      return JSON.stringify(block, null, 2);
    },
  });

  // 3. Update block
  tools.push({
    definition: {
      name: "timeblocking_update_block",
      description: "Update an existing time block. Only provided fields are changed.",
      parameters: {
        type: "object",
        properties: {
          blockId: { type: "string", description: "Block ID (required)" },
          title: { type: "string", description: "New title" },
          date: { type: "string", description: "New date (YYYY-MM-DD)" },
          startTime: { type: "string", description: "New start time (HH:MM)" },
          endTime: { type: "string", description: "New end time (HH:MM)" },
          locked: { type: "boolean", description: "Lock/unlock the block" },
          color: { type: "string", description: "Block color (hex)" },
        },
        required: ["blockId"],
      },
    },
    executor: async (args) => {
      const { blockId, ...changes } = args as Record<string, unknown>;
      const block = await store.updateBlock(blockId as string, changes);
      return JSON.stringify(block, null, 2);
    },
  });

  // 4. Delete block
  tools.push({
    definition: {
      name: "timeblocking_delete_block",
      description: "Delete a time block.",
      parameters: {
        type: "object",
        properties: {
          blockId: { type: "string", description: "Block ID to delete (required)" },
        },
        required: ["blockId"],
      },
    },
    executor: async (args) => {
      await store.deleteBlock(args.blockId as string);
      return JSON.stringify({ success: true, message: "Block deleted" });
    },
  });

  // 5. Schedule task
  tools.push({
    definition: {
      name: "timeblocking_schedule_task",
      description: "Schedule a task onto the timeline at the best available time. Avoids conflicts with existing blocks.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to schedule (required)" },
          date: { type: "string", description: "Date in YYYY-MM-DD format (required)" },
          preferredTime: { type: "string", description: "Preferred start time (HH:MM). Will find nearest available slot if occupied." },
          durationMinutes: { type: "integer", description: "Duration in minutes. Defaults to task estimate or plugin default." },
        },
        required: ["taskId", "date"],
      },
    },
    executor: async (args, ctx) => {
      const taskId = args.taskId as string;
      const date = args.date as string;
      const preferredTime = args.preferredTime as string | undefined;
      const settings = getSettings();

      // Look up task for title and estimate
      let taskTitle = "Scheduled Task";
      let estimatedMinutes = args.durationMinutes as number | undefined;
      if (ctx.taskService) {
        const tasks = await ctx.taskService.list();
        const task = tasks.find((t) => t.id === taskId);
        if (task) {
          taskTitle = task.title;
          if (!estimatedMinutes && task.estimatedMinutes) {
            estimatedMinutes = task.estimatedMinutes;
          }
        }
      }
      const duration = estimatedMinutes ?? settings.defaultDurationMinutes;

      const dayBlocks = store.listBlocks(date);
      const startMin = parseTime(settings.workDayStart);
      const endMin = parseTime(settings.workDayEnd);
      const gridInterval = 30;

      let candidateStart = preferredTime
        ? Math.max(parseTime(preferredTime), startMin)
        : startMin;

      // Round to grid
      candidateStart = Math.round(candidateStart / gridInterval) * gridInterval;

      for (let attempt = 0; attempt < 100; attempt++) {
        const candidateEnd = Math.min(candidateStart + duration, endMin);
        if (candidateEnd <= candidateStart || candidateStart >= endMin) break;

        const hasOverlap = dayBlocks.some((b) =>
          isOverlapping(minutesToTime(candidateStart), minutesToTime(candidateEnd), b.startTime, b.endTime),
        );

        if (!hasOverlap) {
          const block = await store.createBlock({
            title: taskTitle,
            date,
            startTime: minutesToTime(candidateStart),
            endTime: minutesToTime(candidateEnd),
            taskId,
            locked: false,
          });
          return JSON.stringify(block, null, 2);
        }

        candidateStart += gridInterval;
      }

      return JSON.stringify({ error: "No available time slot found on this date" });
    },
  });

  // 6. Get availability
  tools.push({
    definition: {
      name: "timeblocking_get_availability",
      description: "Get free time slots for a given date. Returns intervals between existing blocks within work hours.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date in YYYY-MM-DD format (required)" },
        },
        required: ["date"],
      },
    },
    executor: async (args) => {
      const date = args.date as string;
      const settings = getSettings();
      const dayBlocks = store.listBlocks(date);
      const daySlots = store.listSlots(date);

      // Merge and sort all occupied intervals
      const occupied = [
        ...dayBlocks.map((b) => ({ start: parseTime(b.startTime), end: parseTime(b.endTime) })),
        ...daySlots.map((s) => ({ start: parseTime(s.startTime), end: parseTime(s.endTime) })),
      ].sort((a, b) => a.start - b.start);

      const workStart = parseTime(settings.workDayStart);
      const workEnd = parseTime(settings.workDayEnd);
      const freeSlots: Array<{ start: string; end: string; durationMinutes: number }> = [];
      let current = workStart;

      for (const interval of occupied) {
        if (interval.start > current) {
          freeSlots.push({
            start: minutesToTime(current),
            end: minutesToTime(Math.min(interval.start, workEnd)),
            durationMinutes: Math.min(interval.start, workEnd) - current,
          });
        }
        current = Math.max(current, interval.end);
      }

      if (current < workEnd) {
        freeSlots.push({
          start: minutesToTime(current),
          end: minutesToTime(workEnd),
          durationMinutes: workEnd - current,
        });
      }

      return JSON.stringify(freeSlots, null, 2);
    },
  });

  // 7. Set recurrence
  tools.push({
    definition: {
      name: "timeblocking_set_recurrence",
      description: "Set or update recurrence on a time block.",
      parameters: {
        type: "object",
        properties: {
          blockId: { type: "string", description: "Block ID (required)" },
          frequency: { type: "string", enum: ["daily", "weekly", "monthly"], description: "Recurrence frequency (required)" },
          interval: { type: "integer", description: "Repeat every N intervals (default 1)" },
          daysOfWeek: { type: "array", items: { type: "integer" }, description: "Days of week (0=Sun, 6=Sat) for weekly recurrence" },
          endDate: { type: "string", description: "End date for recurrence (YYYY-MM-DD)" },
        },
        required: ["blockId", "frequency"],
      },
    },
    executor: async (args) => {
      const rule = {
        frequency: args.frequency as "daily" | "weekly" | "monthly",
        interval: (args.interval as number) ?? 1,
        daysOfWeek: args.daysOfWeek as number[] | undefined,
        endDate: args.endDate as string | undefined,
      };
      const block = await store.updateBlock(args.blockId as string, { recurrenceRule: rule });
      return JSON.stringify(block, null, 2);
    },
  });

  // 8. Replan day
  tools.push({
    definition: {
      name: "timeblocking_replan_day",
      description: "Move all incomplete blocks from a past date to a target date. Useful for replanning missed blocks.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "Source date to move blocks from (YYYY-MM-DD, required)" },
          toDate: { type: "string", description: "Target date to move blocks to (YYYY-MM-DD, defaults to today)" },
        },
        required: ["fromDate"],
      },
    },
    executor: async (args) => {
      const fromDate = args.fromDate as string;
      const toDate = (args.toDate as string) ?? new Date().toISOString().split("T")[0];

      const fromBlocks = store.listBlocks(fromDate);
      // Filter to incomplete blocks (non-locked, without completed tasks)
      const toMove = fromBlocks.filter((b) => !b.locked);

      const moved: Array<{ id: string; title: string; newDate: string }> = [];
      for (const block of toMove) {
        await store.updateBlock(block.id, { date: toDate });
        moved.push({ id: block.id, title: block.title, newDate: toDate });
      }

      return JSON.stringify({ moved, count: moved.length }, null, 2);
    },
  });

  return tools;
}
