/**
 * MCP prompt registration.
 * Provides pre-built prompts for common productivity workflows:
 *   plan-my-day, daily-review, quick-capture
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMcpPrompts(server: McpServer): void {
  server.registerPrompt(
    "plan-my-day",
    {
      description:
        "Morning planning prompt — reviews today's tasks, overdue items, and helps prioritize the day.",
      argsSchema: {
        energy_level: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Your energy level this morning (affects task ordering suggestions)"),
      },
    },
    (args) => {
      const energy = args.energy_level ?? "medium";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Plan my day. My energy level is ${energy}.\n\n` +
                `Please:\n` +
                `1. Read my pending tasks for today (use the saydo://tasks/today resource)\n` +
                `2. Check for overdue tasks (use the saydo://tasks/overdue resource)\n` +
                `3. Suggest a prioritized order based on urgency, priority level, and my energy\n` +
                `4. Flag any tasks that might be overcommitted\n` +
                `5. Suggest time blocks if tasks have estimated durations`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "daily-review",
    {
      description: "End-of-day review prompt — summarizes what was accomplished and what's left.",
      argsSchema: {
        date: z.string().optional().describe("Date to review (YYYY-MM-DD). Defaults to today."),
      },
    },
    (args) => {
      const date = args.date ?? new Date().toISOString().split("T")[0];
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Review my day for ${date}.\n\n` +
                `Please:\n` +
                `1. Check today's stats (use the saydo://stats/today resource)\n` +
                `2. List tasks I completed today\n` +
                `3. List tasks still pending that were due today\n` +
                `4. Summarize my productivity and streak\n` +
                `5. Suggest any tasks to reschedule to tomorrow`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "quick-capture",
    {
      description: "Quick task capture — takes a natural language task description and creates it.",
      argsSchema: {
        task: z
          .string()
          .describe(
            "Natural language task description (e.g., 'Buy groceries tomorrow p2 #shopping')",
          ),
      },
    },
    (args) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Create a task from this description: "${args.task}"\n\n` +
                `Parse out any priority (p1-p4), due date, tags (#tag), ` +
                `and project (+project) from the description. ` +
                `Use the create_task tool to create it.`,
            },
          },
        ],
      };
    },
  );
}
