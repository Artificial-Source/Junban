import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const mockFetchDueReminders = vi.fn().mockResolvedValue([]);
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../src/ui/api/tasks.js", () => ({
  fetchDueReminders: (...args: any[]) => mockFetchDueReminders(...args),
  updateTask: (...args: any[]) => mockUpdateTask(...args),
}));

import { useReminders } from "../../../src/ui/hooks/useReminders.js";

describe("useReminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches due reminders on mount", async () => {
    const onReminder = vi.fn();
    renderHook(() => useReminders({ onReminder, intervalMs: 600000 }));
    await vi.advanceTimersByTimeAsync(1500);

    // Wait for the initial async checkReminders to resolve
    await vi.waitFor(() => {
      expect(mockFetchDueReminders).toHaveBeenCalledTimes(1);
    });
  });

  it("fires callback for each due task", async () => {
    mockFetchDueReminders.mockResolvedValueOnce([
      { id: "t1", title: "Reminder 1" },
      { id: "t2", title: "Reminder 2" },
    ]);

    const onReminder = vi.fn();
    renderHook(() => useReminders({ onReminder, intervalMs: 600000 }));
    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() => {
      expect(onReminder).toHaveBeenCalledTimes(2);
    });
    expect(onReminder).toHaveBeenCalledWith({ id: "t1", title: "Reminder 1" });
    expect(onReminder).toHaveBeenCalledWith({ id: "t2", title: "Reminder 2" });
  });

  it("clears remindAt after firing", async () => {
    mockFetchDueReminders.mockResolvedValueOnce([{ id: "t1", title: "R1" }]);

    const onReminder = vi.fn();
    renderHook(() => useReminders({ onReminder, intervalMs: 600000 }));
    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("t1", { remindAt: null });
    });
  });

  it("does not clear reminders when mutation-side effects are disabled", async () => {
    mockFetchDueReminders.mockResolvedValueOnce([{ id: "t1", title: "R1" }]);

    const onReminder = vi.fn();
    renderHook(() =>
      useReminders({
        onReminder,
        intervalMs: 600000,
        clearReminders: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);

    await vi.waitFor(() => {
      expect(onReminder).toHaveBeenCalledWith({ id: "t1", title: "R1" });
    });
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("deduplicates — does not fire same task twice", async () => {
    const task = { id: "t1", title: "R1" };
    // Return the same task on both calls
    mockFetchDueReminders.mockResolvedValue([task]);

    const onReminder = vi.fn();
    // Use a very short interval so polling kicks in quickly
    renderHook(() => useReminders({ onReminder, intervalMs: 50 }));
    await vi.advanceTimersByTimeAsync(1700);

    // Wait for at least 2 fetch calls
    await vi.waitFor(() => {
      expect(mockFetchDueReminders.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // Despite multiple fetches returning the same task, callback only fires once
    expect(onReminder).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when disabled", async () => {
    const onReminder = vi.fn();
    renderHook(() => useReminders({ onReminder, enabled: false }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockFetchDueReminders).not.toHaveBeenCalled();
  });

  it("polls at the specified interval", async () => {
    const onReminder = vi.fn();
    renderHook(() => useReminders({ onReminder, intervalMs: 100 }));
    await vi.advanceTimersByTimeAsync(1900);

    // Initial check is delayed, then interval polling begins.
    expect(mockFetchDueReminders.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
