import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNudges } from "../../../src/ui/hooks/useNudges.js";
import type { Task } from "../../../src/core/types.js";
import type { GeneralSettings } from "../../../src/ui/context/SettingsContext.js";

// Mock format-date to control todayKey
vi.mock("../../../src/utils/format-date.js", () => ({
  toDateKey: () => "2026-02-28",
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    title: overrides.title ?? "Test task",
    description: null,
    status: "pending",
    priority: null,
    dueDate: null,
    dueTime: false,
    completedAt: null,
    projectId: null,
    recurrence: null,
    parentId: null,
    remindAt: null,
    estimatedMinutes: null,
    actualMinutes: null,
    deadline: null,
    isSomeday: false,
    sectionId: null,
    tags: [],
    sortOrder: 0,
    createdAt: "2026-02-28T00:00:00.000Z",
    updatedAt: "2026-02-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeSettings(overrides: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    accent_color: "#3b82f6",
    density: "default",
    font_size: "default",
    reduce_animations: "false",
    week_start: "sunday",
    date_format: "relative",
    time_format: "12h",
    default_priority: "none",
    confirm_delete: "true",
    start_view: "inbox",
    sound_enabled: "true",
    sound_volume: "70",
    sound_complete: "true",
    sound_create: "true",
    sound_delete: "true",
    sound_reminder: "true",
    calendar_default_mode: "week",
    font_family: "outfit",
    feature_sections: "true",
    feature_kanban: "true",
    feature_deadlines: "true",
    feature_duration: "true",
    feature_someday: "true",
    feature_comments: "true",
    feature_stats: "true",
    feature_chords: "true",
    feature_cancelled: "true",
    feature_matrix: "true",
    daily_capacity_minutes: "480",
    nudge_enabled: "true",
    nudge_overdue_alert: "true",
    nudge_deadline_approaching: "true",
    nudge_stale_tasks: "true",
    nudge_empty_today: "true",
    nudge_overloaded_day: "true",
    ...overrides,
  };
}

// Use a very large interval so interval never fires during tests
const NO_INTERVAL = 999999999;

describe("useNudges", () => {
  it("returns nudges from task state", () => {
    const tasks = [makeTask({ id: "t1", dueDate: "2026-02-26T00:00:00.000Z" })];
    const { result } = renderHook(() =>
      useNudges({ tasks, settings: makeSettings(), intervalMs: NO_INTERVAL }),
    );

    expect(result.current.activeNudges.length).toBeGreaterThan(0);
    expect(result.current.activeNudges.find((n) => n.type === "overdue_alert")).toBeDefined();
  });

  it("filters nudges by per-type settings", () => {
    const tasks: Task[] = []; // empty → would fire empty_today
    const settings = makeSettings({ nudge_empty_today: "false" });
    const { result } = renderHook(() =>
      useNudges({ tasks, settings, intervalMs: NO_INTERVAL }),
    );

    expect(result.current.activeNudges.find((n) => n.type === "empty_today")).toBeUndefined();
  });

  it("returns empty when globally disabled", () => {
    const tasks: Task[] = [];
    const settings = makeSettings({ nudge_enabled: "false" });
    const { result } = renderHook(() =>
      useNudges({ tasks, settings, intervalMs: NO_INTERVAL }),
    );

    expect(result.current.activeNudges).toHaveLength(0);
  });

  it("dismiss removes nudge from active list", () => {
    const tasks = [makeTask({ id: "t1", dueDate: "2026-02-26T00:00:00.000Z" })];
    const { result } = renderHook(() =>
      useNudges({ tasks, settings: makeSettings(), intervalMs: NO_INTERVAL }),
    );

    const overdue = result.current.activeNudges.find((n) => n.type === "overdue_alert");
    expect(overdue).toBeDefined();

    act(() => {
      result.current.dismiss(overdue!.id);
    });

    expect(result.current.activeNudges.find((n) => n.type === "overdue_alert")).toBeUndefined();
  });

  it("dismissed nudges stay dismissed after re-render", () => {
    const tasks = [makeTask({ id: "t1", dueDate: "2026-02-26T00:00:00.000Z" })];
    const { result, rerender } = renderHook(
      ({ tasks, settings }) => useNudges({ tasks, settings, intervalMs: NO_INTERVAL }),
      { initialProps: { tasks, settings: makeSettings() } },
    );

    const overdue = result.current.activeNudges.find((n) => n.type === "overdue_alert");
    act(() => {
      result.current.dismiss(overdue!.id);
    });

    // Re-render with same data (simulates re-evaluation)
    rerender({ tasks, settings: makeSettings() });

    expect(result.current.activeNudges.find((n) => n.type === "overdue_alert")).toBeUndefined();
  });

  it("re-evaluates when tasks change", () => {
    const initialTasks: Task[] = [];
    const { result, rerender } = renderHook(
      ({ tasks, settings }) => useNudges({ tasks, settings, intervalMs: NO_INTERVAL }),
      { initialProps: { tasks: initialTasks, settings: makeSettings() } },
    );

    // Should have empty_today nudge
    expect(result.current.activeNudges.find((n) => n.type === "empty_today")).toBeDefined();

    // Add a today task
    const updatedTasks = [makeTask({ dueDate: "2026-02-28T00:00:00.000Z" })];
    rerender({ tasks: updatedTasks, settings: makeSettings() });

    // empty_today should no longer be present
    expect(result.current.activeNudges.find((n) => n.type === "empty_today")).toBeUndefined();
  });

  it("produces no duplicate IDs", () => {
    const tasks = [
      makeTask({ id: "t1", dueDate: "2026-02-26T00:00:00.000Z" }),
      makeTask({ id: "t2", dueDate: "2026-02-27T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const { result } = renderHook(() =>
      useNudges({ tasks, settings: makeSettings(), intervalMs: NO_INTERVAL }),
    );

    const ids = result.current.activeNudges.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
