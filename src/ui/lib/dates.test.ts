import { describe, it, expect } from "vitest";
import { calendarDayKey, todayKey, isValidDateOnly, formatDate, formatRelativeDate } from "./dates";

describe("calendarDayKey", () => {
  it("preserves date-only YYYY-MM-DD without timezone shift", () => {
    expect(calendarDayKey("2026-07-23")).toBe("2026-07-23");
    expect(calendarDayKey("2026-01-01")).toBe("2026-01-01");
  });

  it("returns null for invalid date-only strings", () => {
    expect(calendarDayKey("2026-13-01")).toBeNull();
    expect(calendarDayKey("2026-02-30")).toBeNull();
    expect(calendarDayKey("not-a-date")).toBeNull();
  });

  it("classifies ISO instants in local time", () => {
    // This depends on the local timezone but should produce a valid YYYY-MM-DD
    const key = calendarDayKey("2026-07-23T12:00:00Z");
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("isValidDateOnly", () => {
  it("accepts valid dates", () => {
    expect(isValidDateOnly("2026-07-23")).toBe(true);
    expect(isValidDateOnly("2024-02-29")).toBe(true); // 2024 is a leap year
  });

  it("rejects invalid dates", () => {
    expect(isValidDateOnly("2026-13-01")).toBe(false);
    expect(isValidDateOnly("2025-02-29")).toBe(false); // not a leap year
    expect(isValidDateOnly("2026-07-23T12:00:00Z")).toBe(false);
  });
});

describe("todayKey", () => {
  it("returns a YYYY-MM-DD string", () => {
    const key = todayKey(new Date("2026-07-23T12:00:00-07:00"));
    // In -07:00 timezone, the local date is 2026-07-23
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatDate", () => {
  it("formats date-only strings using local date interpretation", () => {
    // 2026-07-23 as a local date (year, month-1, day)
    const result = formatDate("2026-07-23");
    expect(result).toContain("23");
  });
});

describe("formatRelativeDate", () => {
  it("returns Today for the current date", () => {
    const now = new Date(2026, 6, 23, 12, 0, 0); // July 23, 2026 local
    expect(formatRelativeDate("2026-07-23", now)).toBe("Today");
  });

  it("returns Yesterday for the previous day", () => {
    const now = new Date(2026, 6, 23, 12, 0, 0);
    expect(formatRelativeDate("2026-07-22", now)).toBe("Yesterday");
  });

  it("returns Tomorrow for the next day", () => {
    const now = new Date(2026, 6, 23, 12, 0, 0);
    expect(formatRelativeDate("2026-07-24", now)).toBe("Tomorrow");
  });
});
