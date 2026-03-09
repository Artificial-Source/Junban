import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerMemoryTools } from "../../src/ai/tools/builtin/memory-tools.js";
import { createTestServices } from "../integration/helpers.js";
import type { ToolContext } from "../../src/ai/tools/types.js";

function exec(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return registry.execute(name, args, ctx).then((r) => JSON.parse(r));
}

describe("memory-tools", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerMemoryTools(registry);
    const svc = createTestServices();
    ctx = {
      taskService: svc.taskService,
      projectService: svc.projectService,
      storage: svc.storage,
    };
  });

  describe("save_memory", () => {
    it("saves a memory with default category", async () => {
      const result = await exec(
        registry,
        "save_memory",
        { content: "User likes morning work" },
        ctx,
      );
      expect(result.success).toBe(true);
      expect(result.content).toBe("User likes morning work");
      expect(result.category).toBe("context");
      expect(result.id).toBeDefined();
    });

    it("saves a memory with explicit category", async () => {
      const result = await exec(
        registry,
        "save_memory",
        { content: "Prefers P1 for urgent items", category: "preference" },
        ctx,
      );
      expect(result.success).toBe(true);
      expect(result.category).toBe("preference");
    });

    it("returns error when storage is not available", async () => {
      const noStorageCtx = { ...ctx, storage: undefined };
      const result = await exec(registry, "save_memory", { content: "test" }, noStorageCtx);
      expect(result.error).toBe("Storage not available");
    });
  });

  describe("recall_memories", () => {
    it("returns empty list when no memories", async () => {
      const result = await exec(registry, "recall_memories", {}, ctx);
      expect(result.count).toBe(0);
      expect(result.memories).toEqual([]);
    });

    it("returns saved memories", async () => {
      await exec(registry, "save_memory", { content: "Fact A", category: "habit" }, ctx);
      await exec(registry, "save_memory", { content: "Fact B", category: "preference" }, ctx);

      const result = await exec(registry, "recall_memories", {}, ctx);
      expect(result.count).toBe(2);
      expect(result.memories[0].content).toBe("Fact A");
      expect(result.memories[0].category).toBe("habit");
      expect(result.memories[1].content).toBe("Fact B");
      expect(result.memories[1].category).toBe("preference");
    });

    it("returns error when storage is not available", async () => {
      const noStorageCtx = { ...ctx, storage: undefined };
      const result = await exec(registry, "recall_memories", {}, noStorageCtx);
      expect(result.error).toBe("Storage not available");
    });
  });

  describe("forget_memory", () => {
    it("deletes a memory by id", async () => {
      const saved = await exec(registry, "save_memory", { content: "To forget" }, ctx);
      const result = await exec(registry, "forget_memory", { memoryId: saved.id }, ctx);
      expect(result.success).toBe(true);
      expect(result.deleted).toBe(saved.id);

      const recalled = await exec(registry, "recall_memories", {}, ctx);
      expect(recalled.count).toBe(0);
    });

    it("returns error for non-existent memory", async () => {
      const result = await exec(registry, "forget_memory", { memoryId: "nonexistent" }, ctx);
      expect(result.error).toBe("Memory not found");
    });

    it("returns error when storage is not available", async () => {
      const noStorageCtx = { ...ctx, storage: undefined };
      const result = await exec(registry, "forget_memory", { memoryId: "x" }, noStorageCtx);
      expect(result.error).toBe("Storage not available");
    });
  });

  describe("full workflow", () => {
    it("save, recall, forget cycle works", async () => {
      // Save two memories
      const m1 = await exec(
        registry,
        "save_memory",
        { content: "Daily standup at 10am", category: "habit" },
        ctx,
      );
      const m2 = await exec(
        registry,
        "save_memory",
        { content: "Uses Vim keybindings", category: "preference" },
        ctx,
      );

      // Recall all
      let recalled = await exec(registry, "recall_memories", {}, ctx);
      expect(recalled.count).toBe(2);

      // Forget one
      await exec(registry, "forget_memory", { memoryId: m1.id }, ctx);

      // Verify only one remains
      recalled = await exec(registry, "recall_memories", {}, ctx);
      expect(recalled.count).toBe(1);
      expect(recalled.memories[0].id).toBe(m2.id);
    });
  });
});
