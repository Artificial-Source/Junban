import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  startTimer,
  stopTimer,
  isTimerRunning,
  getActiveTimer,
  getElapsedMinutes,
  clearAllTimers,
  getRunningTimerIds,
  formatMinutes,
  parseEstimateString,
} from "../../src/core/timer.js";
import { createTestServices } from "../integration/helpers.js";

describe("Timer", () => {
  beforeEach(() => {
    clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAllTimers();
  });

  describe("startTimer / stopTimer", () => {
    it("starts and stops a timer, accumulating actualMinutes", () => {
      const { storage, taskService } = createTestServices();

      // Create a task
      let task: Awaited<ReturnType<typeof taskService.create>>;
      vi.useRealTimers();
      // Create task with real timers then switch back
      const createPromise = taskService.create({ title: "Test task", dueTime: false });
      vi.useFakeTimers();

      // We need to handle async in sync vitest — use resolved value
      return createPromise.then((t) => {
        task = t;

        startTimer(task.id);
        expect(isTimerRunning(task.id)).toBe(true);

        // Advance 5 minutes
        vi.advanceTimersByTime(5 * 60 * 1000);

        const elapsed = stopTimer(task.id, storage);
        expect(elapsed).toBe(5);
        expect(isTimerRunning(task.id)).toBe(false);

        // Check actualMinutes was updated in storage
        const rows = storage.getTask(task.id);
        expect(rows[0].actualMinutes).toBe(5);
      });
    });

    it("accumulates time across multiple start/stop cycles", async () => {
      vi.useRealTimers();
      const { storage, taskService } = createTestServices();
      const task = await taskService.create({ title: "Multi-cycle task", dueTime: false });
      vi.useFakeTimers();

      // First cycle: 10 minutes
      startTimer(task.id);
      vi.advanceTimersByTime(10 * 60 * 1000);
      stopTimer(task.id, storage);

      // Second cycle: 5 minutes
      startTimer(task.id);
      vi.advanceTimersByTime(5 * 60 * 1000);
      stopTimer(task.id, storage);

      const rows = storage.getTask(task.id);
      expect(rows[0].actualMinutes).toBe(15);
    });

    it("is a no-op if timer already running", () => {
      startTimer("task-1");
      startTimer("task-1"); // should not throw or reset
      expect(isTimerRunning("task-1")).toBe(true);
    });

    it("returns 0 if no timer running on stop", () => {
      const { storage } = createTestServices();
      const elapsed = stopTimer("nonexistent", storage);
      expect(elapsed).toBe(0);
    });
  });

  describe("getActiveTimer", () => {
    it("returns timer info when running", () => {
      startTimer("task-1");
      const timer = getActiveTimer("task-1");
      expect(timer).toBeDefined();
      expect(timer!.taskId).toBe("task-1");
      expect(timer!.startedAt).toBeGreaterThan(0);
    });

    it("returns undefined when not running", () => {
      expect(getActiveTimer("task-1")).toBeUndefined();
    });
  });

  describe("getElapsedMinutes", () => {
    it("returns elapsed minutes for running timer", () => {
      startTimer("task-1");
      vi.advanceTimersByTime(3 * 60 * 1000);
      expect(getElapsedMinutes("task-1")).toBe(3);
    });

    it("returns 0 for non-running timer", () => {
      expect(getElapsedMinutes("task-1")).toBe(0);
    });
  });

  describe("getRunningTimerIds", () => {
    it("returns all running timer task IDs", () => {
      startTimer("task-1");
      startTimer("task-2");
      const ids = getRunningTimerIds();
      expect(ids).toContain("task-1");
      expect(ids).toContain("task-2");
      expect(ids).toHaveLength(2);
    });

    it("returns empty array when no timers running", () => {
      expect(getRunningTimerIds()).toEqual([]);
    });
  });

  describe("clearAllTimers", () => {
    it("clears all running timers", () => {
      startTimer("task-1");
      startTimer("task-2");
      clearAllTimers();
      expect(isTimerRunning("task-1")).toBe(false);
      expect(isTimerRunning("task-2")).toBe(false);
      expect(getRunningTimerIds()).toEqual([]);
    });
  });
});

describe("formatMinutes", () => {
  it("formats minutes only", () => {
    expect(formatMinutes(30)).toBe("30m");
    expect(formatMinutes(45)).toBe("45m");
  });

  it("formats hours only", () => {
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(120)).toBe("2h");
  });

  it("formats hours and minutes", () => {
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(150)).toBe("2h 30m");
    expect(formatMinutes(75)).toBe("1h 15m");
  });

  it("handles zero and negative", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(-5)).toBe("0m");
  });
});

describe("parseEstimateString", () => {
  it("parses minutes", () => {
    expect(parseEstimateString("30m")).toBe(30);
    expect(parseEstimateString("90m")).toBe(90);
  });

  it("parses hours", () => {
    expect(parseEstimateString("1h")).toBe(60);
    expect(parseEstimateString("2h")).toBe(120);
  });

  it("parses fractional hours", () => {
    expect(parseEstimateString("1.5h")).toBe(90);
    expect(parseEstimateString("0.5h")).toBe(30);
  });

  it("parses compound format", () => {
    expect(parseEstimateString("1h30m")).toBe(90);
    expect(parseEstimateString("2h15m")).toBe(135);
  });

  it("parses compound format with space", () => {
    expect(parseEstimateString("1h 30m")).toBe(90);
  });

  it("parses plain number as minutes", () => {
    expect(parseEstimateString("45")).toBe(45);
  });

  it("returns null for invalid input", () => {
    expect(parseEstimateString("")).toBeNull();
    expect(parseEstimateString("abc")).toBeNull();
    expect(parseEstimateString("h30")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseEstimateString("  30m  ")).toBe(30);
    expect(parseEstimateString("  1h  ")).toBe(60);
  });
});
