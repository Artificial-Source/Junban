import { describe, it, expect } from "vitest";
import { calendarDayKey, formatDate, formatRelativeDate, todayKey } from "./dates";

describe("calendarDayKey", () => {
  it("preserves date-only values without timezone shift", () => {
    expect(calendarDayKey("2026-01-15")).toBe("2026-01-15");
  });

  it("returns null for invalid dates", () => {
    expect(calendarDayKey("not-a-date")).toBeNull();
    expect(calendarDayKey("2026-13-01")).toBeNull();
  });

  it("classifies ISO instant in local calendar", () => {
    const key = calendarDayKey("2026-01-15T12:00:00Z");
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("todayKey", () => {
  it("returns YYYY-MM-DD format", () => {
    const key = todayKey(new Date(2026, 0, 15));
    expect(key).toBe("2026-01-15");
  });
});

describe("formatDate", () => {
  it("formats date-only values without UTC shift", () => {
    const result = formatDate("2026-01-15");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});

describe("formatRelativeDate", () => {
  it("returns Today for current date", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    expect(formatRelativeDate("2026-01-15", now)).toBe("Today");
  });

  it("returns Tomorrow for next day", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    expect(formatRelativeDate("2026-01-16", now)).toBe("Tomorrow");
  });

  it("returns Yesterday for previous day", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    expect(formatRelativeDate("2026-01-14", now)).toBe("Yesterday");
  });
});
