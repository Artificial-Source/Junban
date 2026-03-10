/**
 * Built-in tools for AI memory management.
 * Registers: save_memory, recall_memories, forget_memory
 */

import { generateId } from "../../../utils/ids.js";
import type { ToolRegistry } from "../registry.js";

export function registerMemoryTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "save_memory",
      description:
        "Save an important fact about the user for future conversations. Use for preferences, habits, schedules, work patterns, or instructions. Keep each memory concise (1-2 sentences). Use recall_memories first to avoid duplicates.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact or memory to save (1-2 sentences)",
          },
          category: {
            type: "string",
            enum: ["preference", "habit", "context", "instruction", "pattern"],
            description:
              "Category: preference (likes/dislikes), habit (routines), context (background info), instruction (how to behave), pattern (work patterns)",
          },
        },
        required: ["content"],
      },
    },
    async (args, ctx) => {
      if (!ctx.storage) {
        return JSON.stringify({ error: "Storage not available" });
      }
      const content = args.content as string;
      const category = (args.category as string) || "context";
      const now = new Date().toISOString();

      const row = {
        id: generateId(),
        content,
        category: category as "preference" | "habit" | "context" | "instruction" | "pattern",
        createdAt: now,
        updatedAt: now,
      };
      ctx.storage.insertAiMemory(row);
      return JSON.stringify({ success: true, id: row.id, content, category });
    },
  );

  registry.register(
    {
      name: "recall_memories",
      description:
        "Retrieve all saved memories about the user. Use before save_memory to check for duplicates, or when you need to reference stored facts.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    async (_args, ctx) => {
      if (!ctx.storage) {
        return JSON.stringify({ error: "Storage not available" });
      }
      const memories = ctx.storage.listAiMemories();
      return JSON.stringify({
        count: memories.length,
        memories: memories.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          createdAt: m.createdAt,
        })),
      });
    },
  );

  registry.register(
    {
      name: "forget_memory",
      description:
        "Delete a previously saved memory by its ID. Use when a fact is outdated or the user asks to forget something.",
      parameters: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "The ID of the memory to delete (from recall_memories)",
          },
        },
        required: ["memoryId"],
      },
    },
    async (args, ctx) => {
      if (!ctx.storage) {
        return JSON.stringify({ error: "Storage not available" });
      }
      const memoryId = args.memoryId as string;
      const result = ctx.storage.deleteAiMemory(memoryId);
      if (result.changes === 0) {
        return JSON.stringify({ error: "Memory not found" });
      }
      return JSON.stringify({ success: true, deleted: memoryId });
    },
  );
}
