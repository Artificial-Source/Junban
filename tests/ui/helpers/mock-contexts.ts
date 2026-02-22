import { vi } from "vitest";
import { makeTask, makeProject } from "./mock-api.js";

export { makeTask, makeProject };

/**
 * Creates a mock value for TaskContext's `useTaskContext()`.
 */
export function createMockTaskContext(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      tasks: [],
      projects: [],
      tags: [],
      loading: false,
      error: null,
    },
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue(makeTask()),
    updateTask: vi.fn().mockResolvedValue(makeTask()),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    completeTask: vi.fn().mockResolvedValue(makeTask({ status: "completed" })),
    completeManyTasks: vi.fn().mockResolvedValue([]),
    deleteManyTasks: vi.fn().mockResolvedValue(undefined),
    updateManyTasks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/**
 * Creates default settings matching GeneralSettings defaults.
 */
export function createMockSettings(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
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
      ...((overrides.settings as Record<string, unknown>) ?? {}),
    },
    loaded: true,
    updateSetting: vi.fn(),
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "settings")),
  };
}

/**
 * Creates a mock value for UndoContext's `useUndo()`.
 */
export function createMockUndoContext(overrides: Record<string, unknown> = {}) {
  return {
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    push: vi.fn(),
    ...overrides,
  };
}

/**
 * Creates a mock value for PluginContext's `usePluginContext()`.
 */
export function createMockPluginContext(overrides: Record<string, unknown> = {}) {
  return {
    plugins: [],
    commands: [],
    statusBarItems: [],
    panels: [],
    views: [],
    refreshPlugins: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
