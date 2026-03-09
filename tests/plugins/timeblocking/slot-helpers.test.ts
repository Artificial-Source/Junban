import { describe, it, expect } from "vitest";
import {
  getSlotProgress,
  getSlotColor,
  getSlotEstimatedMinutes,
  isOverlapping,
  findConflicts,
} from "../../../src/plugins/builtin/timeblocking/slot-helpers.js";
import type { TimeBlock, TimeSlot } from "../../../src/plugins/builtin/timeblocking/types.js";

function makeSlot(overrides: Partial<TimeSlot> = {}): TimeSlot {
  return {
    id: "slot-1",
    title: "Morning",
    date: "2026-03-10",
    startTime: "09:00",
    endTime: "11:00",
    taskIds: [],
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

function makeBlock(overrides: Partial<TimeBlock> = {}): TimeBlock {
  return {
    id: "block-1",
    title: "Focus",
    date: "2026-03-10",
    startTime: "09:00",
    endTime: "10:00",
    locked: false,
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

describe("getSlotProgress", () => {
  it("returns zero for empty slot", () => {
    const result = getSlotProgress(makeSlot(), () => undefined);
    expect(result).toEqual({ completed: 0, total: 0, percent: 0 });
  });

  it("counts completed tasks", () => {
    const slot = makeSlot({ taskIds: ["t1", "t2", "t3"] });
    const lookup = (id: string) => ({
      status: id === "t2" ? "completed" : "pending",
    });
    const result = getSlotProgress(slot, lookup);
    expect(result).toEqual({ completed: 1, total: 3, percent: 33 });
  });

  it("handles all completed", () => {
    const slot = makeSlot({ taskIds: ["t1", "t2"] });
    const result = getSlotProgress(slot, () => ({ status: "completed" }));
    expect(result).toEqual({ completed: 2, total: 2, percent: 100 });
  });

  it("handles missing tasks gracefully", () => {
    const slot = makeSlot({ taskIds: ["t1", "t2"] });
    const result = getSlotProgress(slot, () => undefined);
    expect(result).toEqual({ completed: 0, total: 2, percent: 0 });
  });
});

describe("getSlotColor", () => {
  it("returns explicit color when set", () => {
    const slot = makeSlot({ color: "#ff0000", projectId: "proj-1" });
    expect(getSlotColor(slot, () => ({ color: "#00ff00" }))).toBe("#ff0000");
  });

  it("falls back to project color", () => {
    const slot = makeSlot({ projectId: "proj-1" });
    expect(getSlotColor(slot, () => ({ color: "#00ff00" }))).toBe("#00ff00");
  });

  it("falls back to default color", () => {
    const slot = makeSlot();
    expect(getSlotColor(slot, () => undefined)).toBe("#6366f1");
  });

  it("uses custom default color", () => {
    const slot = makeSlot();
    expect(getSlotColor(slot, () => undefined, "#aabbcc")).toBe("#aabbcc");
  });

  it("skips project lookup if no projectId", () => {
    const slot = makeSlot();
    const lookup = vi.fn(() => ({ color: "#00ff00" }));
    getSlotColor(slot, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("getSlotEstimatedMinutes", () => {
  it("sums estimated minutes", () => {
    const slot = makeSlot({ taskIds: ["t1", "t2", "t3"] });
    const lookup = (id: string) => {
      const map: Record<string, number> = { t1: 30, t2: 45, t3: 15 };
      return { estimatedMinutes: map[id] };
    };
    expect(getSlotEstimatedMinutes(slot, lookup)).toBe(90);
  });

  it("treats null/undefined as 0", () => {
    const slot = makeSlot({ taskIds: ["t1", "t2"] });
    const lookup = (id: string) => (id === "t1" ? { estimatedMinutes: 30 } : { estimatedMinutes: null });
    expect(getSlotEstimatedMinutes(slot, lookup)).toBe(30);
  });

  it("returns 0 for empty slot", () => {
    expect(getSlotEstimatedMinutes(makeSlot(), () => undefined)).toBe(0);
  });
});

describe("isOverlapping", () => {
  it("detects overlapping ranges", () => {
    expect(isOverlapping("09:00", "10:00", "09:30", "10:30")).toBe(true);
  });

  it("detects contained ranges", () => {
    expect(isOverlapping("09:00", "12:00", "10:00", "11:00")).toBe(true);
  });

  it("adjacent ranges do not overlap", () => {
    expect(isOverlapping("09:00", "10:00", "10:00", "11:00")).toBe(false);
  });

  it("non-overlapping ranges", () => {
    expect(isOverlapping("09:00", "10:00", "11:00", "12:00")).toBe(false);
  });

  it("identical ranges overlap", () => {
    expect(isOverlapping("09:00", "10:00", "09:00", "10:00")).toBe(true);
  });
});

describe("findConflicts", () => {
  it("finds conflicts between blocks", () => {
    const blocks = [
      makeBlock({ id: "b1", startTime: "09:00", endTime: "10:00" }),
      makeBlock({ id: "b2", startTime: "09:30", endTime: "10:30" }),
    ];
    const conflicts = findConflicts(blocks, [], "2026-03-10");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].a.id).toBe("b1");
    expect(conflicts[0].b.id).toBe("b2");
  });

  it("finds conflicts between block and slot", () => {
    const blocks = [makeBlock({ id: "b1", startTime: "09:00", endTime: "10:00" })];
    const slots = [makeSlot({ id: "s1", startTime: "09:30", endTime: "11:00" })];
    const conflicts = findConflicts(blocks, slots, "2026-03-10");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].a.type).toBe("block");
    expect(conflicts[0].b.type).toBe("slot");
  });

  it("returns empty for no conflicts", () => {
    const blocks = [
      makeBlock({ id: "b1", startTime: "09:00", endTime: "10:00" }),
      makeBlock({ id: "b2", startTime: "10:00", endTime: "11:00" }),
    ];
    expect(findConflicts(blocks, [], "2026-03-10")).toHaveLength(0);
  });

  it("only considers items on the specified date", () => {
    const blocks = [
      makeBlock({ id: "b1", date: "2026-03-10", startTime: "09:00", endTime: "10:00" }),
      makeBlock({ id: "b2", date: "2026-03-11", startTime: "09:00", endTime: "10:00" }),
    ];
    expect(findConflicts(blocks, [], "2026-03-10")).toHaveLength(0);
  });
});

// Need vi for spy
import { vi } from "vitest";
