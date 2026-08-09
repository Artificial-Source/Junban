import { afterEach, describe, expect, it } from "vitest";
import {
  getConfirmedDateFormat,
  getConfirmedTimeFormat,
  resetDateTimePreferencesForTests,
  setConfirmedDateTimePreferences,
} from "./dateTimePreferences";
import { formatCivilTime, formatDate, formatTimestampTime } from "./dates";

afterEach(() => {
  resetDateTimePreferencesForTests();
});

describe("dateTimePreferences", () => {
  it("defaults to short date and h24 time", () => {
    expect(getConfirmedDateFormat()).toBe("short");
    expect(getConfirmedTimeFormat()).toBe("h24");
  });

  it("updates only through confirmed snapshots", () => {
    setConfirmedDateTimePreferences({ dateFormat: "long", timeFormat: "h12" });
    expect(getConfirmedDateFormat()).toBe("long");
    expect(getConfirmedTimeFormat()).toBe("h12");
  });
});

describe("formatDate preferences", () => {
  it("uses short by default without UTC shift", () => {
    const result = formatDate("2026-07-23");
    expect(result).toContain("23");
  });

  it("implements relative/short/long/iso", () => {
    const now = new Date(2026, 6, 23, 12, 0, 0);
    setConfirmedDateTimePreferences({ dateFormat: "relative", timeFormat: "h24" });
    expect(formatDate("2026-07-23", now)).toBe("Today");

    setConfirmedDateTimePreferences({ dateFormat: "iso", timeFormat: "h24" });
    expect(formatDate("2026-07-23", now)).toBe("2026-07-23");

    setConfirmedDateTimePreferences({ dateFormat: "long", timeFormat: "h24" });
    const long = formatDate("2026-07-23", now);
    expect(long.toLowerCase()).toContain("july");
    expect(long).toContain("23");

    setConfirmedDateTimePreferences({ dateFormat: "short", timeFormat: "h24" });
    expect(formatDate("2026-07-23", now)).toContain("23");
  });
});

describe("formatCivilTime / formatTimestampTime preferences", () => {
  it("honors h12 and h24", () => {
    setConfirmedDateTimePreferences({ dateFormat: "short", timeFormat: "h24" });
    expect(formatCivilTime("14:30")).toBe("14:30");
    setConfirmedDateTimePreferences({ dateFormat: "short", timeFormat: "h12" });
    expect(formatCivilTime("14:30")).toBe("2:30 PM");
    expect(formatCivilTime("00:05")).toBe("12:05 AM");

    const stamp = "2026-07-23T14:30:00";
    setConfirmedDateTimePreferences({ dateFormat: "short", timeFormat: "h24" });
    const h24 = formatTimestampTime(stamp);
    setConfirmedDateTimePreferences({ dateFormat: "short", timeFormat: "h12" });
    const h12 = formatTimestampTime(stamp);
    expect(h24).not.toEqual(h12);
  });
});
