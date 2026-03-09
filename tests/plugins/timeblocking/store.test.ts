import { describe, it, expect, beforeEach, vi } from "vitest";
import { TimeBlockStore } from "../../../src/plugins/builtin/timeblocking/store.js";
import type { PluginStorageAPI } from "../../../src/plugins/builtin/timeblocking/types.js";

function createMockStorage(): PluginStorageAPI {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string) => (data.get(key) as T) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    keys: vi.fn(async () => Array.from(data.keys())),
  };
}

function blockInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Focus time",
    date: "2026-03-10",
    startTime: "09:00",
    endTime: "10:00",
    locked: false,
    ...overrides,
  };
}

function slotInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Morning slot",
    date: "2026-03-10",
    startTime: "09:00",
    endTime: "11:00",
    taskIds: [],
    ...overrides,
  };
}

describe("TimeBlockStore", () => {
  let store: TimeBlockStore;
  let storage: PluginStorageAPI;

  beforeEach(async () => {
    storage = createMockStorage();
    store = new TimeBlockStore(storage);
    await store.initialize();
  });

  describe("initialization", () => {
    it("loads blocks and slots from storage on init", async () => {
      expect(storage.get).toHaveBeenCalledWith("blocks");
      expect(storage.get).toHaveBeenCalledWith("slots");
    });

    it("throws if not initialized", () => {
      const uninit = new TimeBlockStore(createMockStorage());
      expect(() => uninit.listBlocks()).toThrow("not initialized");
    });
  });

  describe("block CRUD", () => {
    it("creates a block with generated id and timestamps", async () => {
      const block = await store.createBlock(blockInput());
      expect(block.id).toBeTruthy();
      expect(block.title).toBe("Focus time");
      expect(block.createdAt).toBeTruthy();
      expect(block.updatedAt).toBeTruthy();
    });

    it("lists all blocks", async () => {
      await store.createBlock(blockInput());
      await store.createBlock(blockInput({ title: "Second block" }));
      expect(store.listBlocks()).toHaveLength(2);
    });

    it("lists blocks by date", async () => {
      await store.createBlock(blockInput({ date: "2026-03-10" }));
      await store.createBlock(blockInput({ date: "2026-03-11" }));
      expect(store.listBlocks("2026-03-10")).toHaveLength(1);
    });

    it("lists blocks in date range", async () => {
      await store.createBlock(blockInput({ date: "2026-03-09" }));
      await store.createBlock(blockInput({ date: "2026-03-10" }));
      await store.createBlock(blockInput({ date: "2026-03-12" }));
      expect(store.listBlocksInRange("2026-03-09", "2026-03-11")).toHaveLength(2);
    });

    it("gets a block by id", async () => {
      const block = await store.createBlock(blockInput());
      expect(store.getBlock(block.id)).toEqual(block);
    });

    it("returns null for unknown block id", () => {
      expect(store.getBlock("nonexistent")).toBeNull();
    });

    it("updates a block", async () => {
      const block = await store.createBlock(blockInput());
      // Ensure timestamp difference
      await new Promise((r) => setTimeout(r, 5));
      const updated = await store.updateBlock(block.id, { title: "Updated" });
      expect(updated.title).toBe("Updated");
      expect(updated.updatedAt).not.toBe(block.updatedAt);
    });

    it("throws when updating nonexistent block", async () => {
      await expect(store.updateBlock("nope", { title: "X" })).rejects.toThrow("not found");
    });

    it("deletes a block", async () => {
      const block = await store.createBlock(blockInput());
      await store.deleteBlock(block.id);
      expect(store.listBlocks()).toHaveLength(0);
    });

    it("throws when deleting nonexistent block", async () => {
      await expect(store.deleteBlock("nope")).rejects.toThrow("not found");
    });

    it("persists after create", async () => {
      await store.createBlock(blockInput());
      expect(storage.set).toHaveBeenCalledWith("blocks", expect.any(Array));
    });
  });

  describe("slot CRUD", () => {
    it("creates a slot", async () => {
      const slot = await store.createSlot(slotInput());
      expect(slot.id).toBeTruthy();
      expect(slot.title).toBe("Morning slot");
      expect(slot.taskIds).toEqual([]);
    });

    it("lists slots by date", async () => {
      await store.createSlot(slotInput({ date: "2026-03-10" }));
      await store.createSlot(slotInput({ date: "2026-03-11" }));
      expect(store.listSlots("2026-03-10")).toHaveLength(1);
    });

    it("lists slots in range", async () => {
      await store.createSlot(slotInput({ date: "2026-03-09" }));
      await store.createSlot(slotInput({ date: "2026-03-10" }));
      await store.createSlot(slotInput({ date: "2026-03-12" }));
      expect(store.listSlotsInRange("2026-03-09", "2026-03-11")).toHaveLength(2);
    });

    it("gets a slot by id", async () => {
      const slot = await store.createSlot(slotInput());
      expect(store.getSlot(slot.id)).toEqual(slot);
    });

    it("updates a slot", async () => {
      const slot = await store.createSlot(slotInput());
      const updated = await store.updateSlot(slot.id, { title: "Afternoon" });
      expect(updated.title).toBe("Afternoon");
    });

    it("deletes a slot", async () => {
      const slot = await store.createSlot(slotInput());
      await store.deleteSlot(slot.id);
      expect(store.listSlots()).toHaveLength(0);
    });

    it("persists after slot create", async () => {
      await store.createSlot(slotInput());
      expect(storage.set).toHaveBeenCalledWith("slots", expect.any(Array));
    });
  });

  describe("slot task management", () => {
    it("adds a task to a slot", async () => {
      const slot = await store.createSlot(slotInput());
      const updated = await store.addTaskToSlot(slot.id, "task-1");
      expect(updated.taskIds).toEqual(["task-1"]);
    });

    it("does not add duplicate task", async () => {
      const slot = await store.createSlot(slotInput());
      await store.addTaskToSlot(slot.id, "task-1");
      await store.addTaskToSlot(slot.id, "task-1");
      expect(store.getSlot(slot.id)!.taskIds).toEqual(["task-1"]);
    });

    it("removes a task from a slot", async () => {
      const slot = await store.createSlot(slotInput());
      await store.addTaskToSlot(slot.id, "task-1");
      await store.addTaskToSlot(slot.id, "task-2");
      await store.removeTaskFromSlot(slot.id, "task-1");
      expect(store.getSlot(slot.id)!.taskIds).toEqual(["task-2"]);
    });

    it("reorders tasks in a slot", async () => {
      const slot = await store.createSlot(slotInput());
      await store.addTaskToSlot(slot.id, "task-1");
      await store.addTaskToSlot(slot.id, "task-2");
      await store.reorderSlotTasks(slot.id, ["task-2", "task-1"]);
      expect(store.getSlot(slot.id)!.taskIds).toEqual(["task-2", "task-1"]);
    });

    it("throws when adding to nonexistent slot", async () => {
      await expect(store.addTaskToSlot("nope", "task-1")).rejects.toThrow("not found");
    });
  });

  describe("validation", () => {
    it("rejects empty title", async () => {
      await expect(store.createBlock(blockInput({ title: "" }))).rejects.toThrow("non-empty");
    });

    it("rejects whitespace-only title", async () => {
      await expect(store.createBlock(blockInput({ title: "   " }))).rejects.toThrow("non-empty");
    });

    it("rejects invalid date format", async () => {
      await expect(store.createBlock(blockInput({ date: "03/10/2026" }))).rejects.toThrow(
        "Invalid date format",
      );
    });

    it("rejects startTime after endTime", async () => {
      await expect(
        store.createBlock(blockInput({ startTime: "10:00", endTime: "09:00" })),
      ).rejects.toThrow("must be before");
    });

    it("rejects duration less than 15 minutes", async () => {
      await expect(
        store.createBlock(blockInput({ startTime: "09:00", endTime: "09:10" })),
      ).rejects.toThrow("at least 15 minutes");
    });

    it("rejects invalid startTime format", async () => {
      await expect(
        store.createBlock(blockInput({ startTime: "9am" })),
      ).rejects.toThrow("Invalid startTime");
    });

    it("validates on update too", async () => {
      const block = await store.createBlock(blockInput());
      await expect(store.updateBlock(block.id, { title: "" })).rejects.toThrow("non-empty");
    });

    it("validates time range on update", async () => {
      const block = await store.createBlock(blockInput());
      await expect(
        store.updateBlock(block.id, { startTime: "11:00", endTime: "10:00" }),
      ).rejects.toThrow("must be before");
    });
  });
});
