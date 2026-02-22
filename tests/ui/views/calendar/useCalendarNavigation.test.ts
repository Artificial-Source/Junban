import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useCalendarNavigation,
  getWeekStart,
  getWeekDays,
} from "../../../../src/ui/views/calendar/useCalendarNavigation.js";

// Mock SettingsContext
const mockSettings = {
  week_start: "sunday" as const,
};

vi.mock("../../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: mockSettings,
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

describe("getWeekStart (pure)", () => {
  it("returns Sunday for week_start=sunday (0)", () => {
    // Wednesday Feb 19, 2026
    const wed = new Date(2026, 1, 19);
    const start = getWeekStart(wed, 0);
    expect(start.getDay()).toBe(0); // Sunday
    expect(start.getDate()).toBe(15);
  });

  it("returns Monday for week_start=monday (1)", () => {
    const wed = new Date(2026, 1, 19);
    const start = getWeekStart(wed, 1);
    expect(start.getDay()).toBe(1); // Monday
    expect(start.getDate()).toBe(16);
  });

  it("returns Saturday for week_start=saturday (6)", () => {
    const wed = new Date(2026, 1, 19);
    const start = getWeekStart(wed, 6);
    expect(start.getDay()).toBe(6); // Saturday
    expect(start.getDate()).toBe(14);
  });

  it("returns the same day if it IS the week start", () => {
    // Sunday Feb 15, 2026
    const sun = new Date(2026, 1, 15);
    const start = getWeekStart(sun, 0);
    expect(start.getDate()).toBe(15);
  });
});

describe("getWeekDays (pure)", () => {
  it("returns exactly 7 days", () => {
    const days = getWeekDays(new Date(2026, 1, 19), 0);
    expect(days).toHaveLength(7);
  });

  it("starts on the correct week start day", () => {
    const days = getWeekDays(new Date(2026, 1, 19), 1); // Monday start
    expect(days[0].getDay()).toBe(1); // Monday
    expect(days[6].getDay()).toBe(0); // Sunday
  });

  it("days are consecutive", () => {
    const days = getWeekDays(new Date(2026, 1, 19), 0);
    for (let i = 1; i < 7; i++) {
      expect(days[i].getDate() - days[i - 1].getDate()).toBe(1);
    }
  });
});

describe("useCalendarNavigation", () => {
  beforeEach(() => {
    mockSettings.week_start = "sunday";
  });

  it("defaults to week mode", () => {
    const { result } = renderHook(() => useCalendarNavigation());
    expect(result.current.mode).toBe("week");
  });

  it("respects initialMode option", () => {
    const { result } = renderHook(() => useCalendarNavigation({ initialMode: "month" }));
    expect(result.current.mode).toBe("month");
  });

  it("setMode changes mode and fires callback", () => {
    const onModeChange = vi.fn();
    const { result } = renderHook(() => useCalendarNavigation({ onModeChange }));

    act(() => {
      result.current.setMode("day");
    });
    expect(result.current.mode).toBe("day");
    expect(onModeChange).toHaveBeenCalledWith("day");
  });

  it("goNext advances by 1 day in day mode", () => {
    const { result } = renderHook(() => useCalendarNavigation({ initialMode: "day" }));

    const initialDate = result.current.selectedDate.getDate();

    act(() => {
      result.current.goNext();
    });
    expect(result.current.selectedDate.getDate()).toBe(initialDate + 1);
  });

  it("goPrev goes back by 7 days in week mode", () => {
    const { result } = renderHook(() => useCalendarNavigation());

    const initialTime = result.current.selectedDate.getTime();

    act(() => {
      result.current.goPrev();
    });

    const diff = initialTime - result.current.selectedDate.getTime();
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("goToday sets date to today", () => {
    const { result } = renderHook(() => useCalendarNavigation({ initialMode: "day" }));

    // Navigate away from today
    act(() => {
      result.current.goNext();
      result.current.goNext();
      result.current.goNext();
    });

    act(() => {
      result.current.goToday();
    });

    const now = new Date();
    expect(result.current.selectedDate.getDate()).toBe(now.getDate());
    expect(result.current.selectedDate.getMonth()).toBe(now.getMonth());
  });

  it("periodLabel formats correctly for month mode", () => {
    const { result } = renderHook(() => useCalendarNavigation({ initialMode: "month" }));

    // Should contain month name and year
    const label = result.current.periodLabel;
    const now = new Date();
    expect(label).toContain(String(now.getFullYear()));
  });

  it("isCurrentPeriod is true for today", () => {
    const { result } = renderHook(() => useCalendarNavigation({ initialMode: "day" }));
    expect(result.current.isCurrentPeriod).toBe(true);
  });

  it("isCurrentPeriod becomes false after navigating away", () => {
    const { result } = renderHook(() => useCalendarNavigation({ initialMode: "month" }));

    act(() => {
      result.current.goNext(); // Next month
    });
    expect(result.current.isCurrentPeriod).toBe(false);
  });

  it("goNext advances by 1 month in month mode", () => {
    const { result } = renderHook(() => useCalendarNavigation({ initialMode: "month" }));

    const initialMonth = result.current.selectedDate.getMonth();

    act(() => {
      result.current.goNext();
    });
    expect(result.current.selectedDate.getMonth()).toBe((initialMonth + 1) % 12);
  });

  it("weekStartDay reflects the setting", () => {
    mockSettings.week_start = "monday";
    const { result } = renderHook(() => useCalendarNavigation());
    expect(result.current.weekStartDay).toBe(1);
  });
});
