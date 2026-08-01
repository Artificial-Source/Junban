import { describe, expect, it } from "vitest";
import {
  civilTimeToMinutes,
  clampCivilRange,
  dayCountForMode,
  formatTimeblockingRangeLabel,
  isVirtualOccurrence,
  minutesToCivilTime,
  normalizeCivilTime,
  occurrenceKey,
  replanLookbackRange,
  seriesOwnerId,
  snapToGrid,
  timeblockingRequestRange,
} from "./timeblockingRange";

describe("timeblockingRange", () => {
  it("serializes day and week inclusive civil ranges without UTC drift", () => {
    // Local noon avoids DST edge ambiguity for the Date constructor used by navigation.
    const selected = new Date(2026, 6, 23, 12, 0, 0);
    expect(timeblockingRequestRange(selected, "day")).toEqual({
      from: "2026-07-23",
      to: "2026-07-23",
    });
    expect(timeblockingRequestRange(selected, "week")).toEqual({
      from: "2026-07-23",
      to: "2026-07-29",
    });
    expect(dayCountForMode("week")).toBe(7);
  });

  it("does not shift civil YYYY-MM-DD through UTC when labeling ranges", () => {
    const selected = new Date(2026, 0, 1, 15, 30, 0);
    const dayLabel = formatTimeblockingRangeLabel(selected, "day");
    expect(dayLabel).toContain("January");
    expect(dayLabel).toContain("2026");
    expect(dayLabel).toContain("1");

    const week = timeblockingRequestRange(selected, "week");
    expect(week.from).toBe("2026-01-01");
    expect(week.to).toBe("2026-01-07");
  });

  it("builds stable virtual occurrence keys and series owner ids", () => {
    expect(occurrenceKey("owner-1", "2026-07-24")).toBe("owner-1:2026-07-24");
    expect(
      seriesOwnerId({
        id: "owner-1",
        recurrence_parent_id: "owner-1",
      }),
    ).toBe("owner-1");
    expect(isVirtualOccurrence({ date: "2026-07-24", recurrence_parent_id: "owner-1" })).toBe(true);
    expect(isVirtualOccurrence({ date: "2026-07-23", recurrence_parent_id: null })).toBe(false);
  });

  it("parses civil times without inventing Date/UTC math", () => {
    expect(civilTimeToMinutes("09:00")).toBe(9 * 60);
    expect(civilTimeToMinutes("09:00:00")).toBe(9 * 60);
    expect(civilTimeToMinutes("17:30:45")).toBe(17 * 60 + 30);
    expect(normalizeCivilTime("09:00:00")).toBe("09:00");
    expect(minutesToCivilTime(9 * 60 + 15)).toBe("09:15");
  });

  it("snaps and clamps move/resize ranges to the workday grid", () => {
    expect(snapToGrid(9 * 60 + 7, 15)).toBe(9 * 60);
    expect(snapToGrid(9 * 60 + 8, 15)).toBe(9 * 60 + 15);
    expect(snapToGrid(9 * 60 + 7, 5)).toBe(9 * 60 + 5);

    const clamped = clampCivilRange(8 * 60, 18 * 60, 9 * 60, 17 * 60, {
      minDuration: 15,
      gridInterval: 15,
    });
    expect(clamped.start).toBe(9 * 60);
    expect(clamped.end).toBe(17 * 60);

    const short = clampCivilRange(16 * 60 + 50, 16 * 60 + 55, 9 * 60, 17 * 60, {
      minDuration: 15,
      gridInterval: 15,
    });
    expect(short.end - short.start).toBeGreaterThanOrEqual(15);
    expect(short.end).toBeLessThanOrEqual(17 * 60);
  });

  it("computes replan lookback as the prior seven complete civil days", () => {
    expect(replanLookbackRange("2026-07-23")).toEqual({
      from: "2026-07-16",
      to: "2026-07-22",
    });
  });
});
