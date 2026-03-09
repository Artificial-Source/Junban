import { describe, it, expect } from "vitest";
import { expandRecurrence } from "../../../src/plugins/builtin/timeblocking/recurrence.js";
import type { RecurrenceRule } from "../../../src/plugins/builtin/timeblocking/types.js";

function makeItem(date: string, rule?: RecurrenceRule) {
  return {
    id: "block-1",
    date,
    title: "Recurring",
    startTime: "09:00",
    endTime: "10:00",
    recurrenceRule: rule,
  };
}

describe("expandRecurrence", () => {
  describe("daily", () => {
    it("expands daily interval=1", () => {
      const item = makeItem("2026-03-01", { frequency: "daily", interval: 1 });
      const results = expandRecurrence(item, "2026-03-01", "2026-03-05");
      // Should produce instances for 02, 03, 04, 05 (not 01 which is the parent)
      expect(results).toHaveLength(4);
      expect(results.map((r) => r.date)).toEqual([
        "2026-03-02",
        "2026-03-03",
        "2026-03-04",
        "2026-03-05",
      ]);
    });

    it("expands daily interval=2 (every other day)", () => {
      const item = makeItem("2026-03-01", { frequency: "daily", interval: 2 });
      const results = expandRecurrence(item, "2026-03-01", "2026-03-07");
      expect(results.map((r) => r.date)).toEqual(["2026-03-03", "2026-03-05", "2026-03-07"]);
    });

    it("generates deterministic IDs", () => {
      const item = makeItem("2026-03-01", { frequency: "daily", interval: 1 });
      const results = expandRecurrence(item, "2026-03-02", "2026-03-03");
      expect(results[0].id).toBe("block-1_2026-03-02");
      expect(results[1].id).toBe("block-1_2026-03-03");
    });

    it("sets recurrenceParentId", () => {
      const item = makeItem("2026-03-01", { frequency: "daily", interval: 1 });
      const results = expandRecurrence(item, "2026-03-02", "2026-03-02");
      expect(results[0].recurrenceParentId).toBe("block-1");
    });

    it("clears recurrenceRule on instances", () => {
      const item = makeItem("2026-03-01", { frequency: "daily", interval: 1 });
      const results = expandRecurrence(item, "2026-03-02", "2026-03-02");
      expect(results[0].recurrenceRule).toBeUndefined();
    });
  });

  describe("weekly", () => {
    it("expands weekly with specific days", () => {
      // 2026-03-02 is Monday
      const item = makeItem("2026-03-02", {
        frequency: "weekly",
        interval: 1,
        daysOfWeek: [1, 3, 5], // Mon, Wed, Fri
      });
      const results = expandRecurrence(item, "2026-03-02", "2026-03-13");
      const dates = results.map((r) => r.date);
      // Mon 03-02 is parent (excluded), Wed 03-04, Fri 03-06, Mon 03-09, Wed 03-11, Fri 03-13
      expect(dates).toContain("2026-03-04");
      expect(dates).toContain("2026-03-06");
      expect(dates).toContain("2026-03-09");
      expect(dates).toContain("2026-03-11");
      expect(dates).toContain("2026-03-13");
    });

    it("expands weekly interval=2 (every other week)", () => {
      const item = makeItem("2026-03-02", {
        frequency: "weekly",
        interval: 2,
        daysOfWeek: [1], // Monday
      });
      const results = expandRecurrence(item, "2026-03-02", "2026-03-30");
      const dates = results.map((r) => r.date);
      // 03-02 parent (excluded), 03-16, 03-30
      expect(dates).toContain("2026-03-16");
      expect(dates).toContain("2026-03-30");
      expect(dates).not.toContain("2026-03-09"); // skipped week
    });

    it("defaults to origin's day of week when daysOfWeek not specified", () => {
      // 2026-03-02 is Monday (day 1)
      const item = makeItem("2026-03-02", { frequency: "weekly", interval: 1 });
      const results = expandRecurrence(item, "2026-03-02", "2026-03-16");
      const dates = results.map((r) => r.date);
      expect(dates).toContain("2026-03-09");
      expect(dates).toContain("2026-03-16");
    });
  });

  describe("monthly", () => {
    it("expands monthly on same day", () => {
      const item = makeItem("2026-01-15", { frequency: "monthly", interval: 1 });
      const results = expandRecurrence(item, "2026-01-01", "2026-04-30");
      const dates = results.map((r) => r.date);
      expect(dates).toContain("2026-02-15");
      expect(dates).toContain("2026-03-15");
      expect(dates).toContain("2026-04-15");
    });

    it("skips months where date doesn't exist (e.g. Feb 31)", () => {
      const item = makeItem("2026-01-31", { frequency: "monthly", interval: 1 });
      const results = expandRecurrence(item, "2026-01-01", "2026-04-30");
      const dates = results.map((r) => r.date);
      // Feb has no 31, so skipped. March 31 exists.
      expect(dates).not.toContain("2026-02-31");
      expect(dates).toContain("2026-03-31");
    });

    it("expands monthly interval=2", () => {
      const item = makeItem("2026-01-10", { frequency: "monthly", interval: 2 });
      const results = expandRecurrence(item, "2026-01-01", "2026-07-31");
      const dates = results.map((r) => r.date);
      expect(dates).toContain("2026-03-10");
      expect(dates).toContain("2026-05-10");
      expect(dates).toContain("2026-07-10");
      expect(dates).not.toContain("2026-02-10"); // skipped
    });
  });

  describe("endDate", () => {
    it("stops generating after endDate", () => {
      const item = makeItem("2026-03-01", {
        frequency: "daily",
        interval: 1,
        endDate: "2026-03-03",
      });
      const results = expandRecurrence(item, "2026-03-01", "2026-03-10");
      expect(results).toHaveLength(2); // 03-02, 03-03
    });
  });

  describe("edge cases", () => {
    it("returns empty for no recurrence rule", () => {
      const item = makeItem("2026-03-01");
      expect(expandRecurrence(item, "2026-03-01", "2026-03-10")).toEqual([]);
    });

    it("returns empty when range start > end", () => {
      const item = makeItem("2026-03-01", { frequency: "daily", interval: 1 });
      expect(expandRecurrence(item, "2026-03-10", "2026-03-01")).toEqual([]);
    });

    it("copies all fields from parent", () => {
      const item = {
        ...makeItem("2026-03-01", { frequency: "daily", interval: 1 }),
        startTime: "14:00",
        endTime: "15:00",
      };
      const results = expandRecurrence(item, "2026-03-02", "2026-03-02");
      expect(results[0].startTime).toBe("14:00");
      expect(results[0].endTime).toBe("15:00");
      expect(results[0].title).toBe("Recurring");
    });
  });
});
