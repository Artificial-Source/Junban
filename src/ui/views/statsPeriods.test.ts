import { describe, expect, it } from "vitest";
import type { StatsResponse } from "../api/client";
import {
  chartRowsWithToday,
  completionsInRange,
  completionsOnDay,
  formatMinutes,
  statsPeriodRange,
} from "./statsPeriods";

const sampleStats: StatsResponse = {
  revision: 1,
  from: "2026-07-17",
  to: "2026-07-23",
  current_streak_days: 7,
  estimate_accuracy_percent: 88,
  estimate_accuracy_samples: 14,
  total_completion_minutes: 1500,
  total_completions: 15,
  total_creations: 4,
  days: [
    { date: "2026-07-17", completions: 2, creations: 0, completion_minutes: 60 },
    { date: "2026-07-18", completions: 1, creations: 1, completion_minutes: 30 },
    { date: "2026-07-23", completions: 3, creations: 0, completion_minutes: 90 },
  ],
};

describe("stats periods", () => {
  it("maps named periods to inclusive civil ranges ending today", () => {
    expect(statsPeriodRange("7d", "2026-07-23")).toEqual({
      from: "2026-07-17",
      to: "2026-07-23",
    });
    expect(statsPeriodRange("30d", "2026-07-23")).toEqual({
      from: "2026-06-24",
      to: "2026-07-23",
    });
    expect(statsPeriodRange("90d", "2026-07-23").to).toBe("2026-07-23");
    expect(statsPeriodRange("1y", "2026-07-23").from).toBe("2025-07-24");
  });

  it("reads completions only from server day buckets", () => {
    expect(completionsOnDay(sampleStats.days, "2026-07-23")).toBe(3);
    expect(completionsOnDay(sampleStats.days, "2026-07-19")).toBe(0);
    expect(completionsInRange(sampleStats.days, "2026-07-17", "2026-07-23")).toBe(6);
  });

  it("builds chart rows from server buckets without inventing missing days", () => {
    const rows = chartRowsWithToday(sampleStats, "2026-07-23");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ key: "2026-07-23", count: 3, isToday: true });
  });

  it("formats tracked minutes for cards", () => {
    expect(formatMinutes(30)).toBe("30m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(90)).toBe("1.5h");
  });
});
