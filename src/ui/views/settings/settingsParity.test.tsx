/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsResponse, MutationResponse, TaskDto } from "../../api/client";
import { QuickAddModal } from "../../components/QuickAddModal";
import { TaskDetailPanel } from "../../components/TaskDetailPanel";
import { KeyboardTab } from "./KeyboardTab";
import { TWO_KEY_CHORD_TIMEOUT_MS } from "./keyboardShortcuts";
import { TemplatesTab } from "./TemplatesTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveSettings = vi.fn();
const deleteTask = vi.fn();
let settingsSnapshot: AppSettingsResponse;

const baseSettings = (): AppSettingsResponse => ({
  appearance: {
    theme: "light",
    accent: "#3b82f6",
    density: "comfortable",
    font_size: "medium",
    font_family: "outfit",
    reduced_motion: false,
  },
  date_time: {
    week_start: "sunday",
    calendar_default: "week",
    date_format: "short",
    time_format: "h24",
  },
  task_defaults: {
    default_priority: null,
    default_view: "today",
    default_estimated_minutes: null,
    confirm_before_delete: true,
  },
  notifications: {
    channels: ["in_app"],
    sound_enabled: true,
    volume_percent: 70,
    task_completed_sound: true,
    task_created_sound: true,
    task_deleted_sound: true,
    reminder_sound: true,
  },
  features: {
    nudges_enabled: true,
    eat_the_frog_enabled: false,
    task_jar_enabled: false,
    focus_mode_enabled: false,
    daily_planning_enabled: true,
    weekly_review_enabled: true,
  },
  planning: {
    capacity_minutes: 480,
    work_hours: null,
    nudge_rules: [
      { kind: "overdue", enabled: true, threshold: null },
      { kind: "approaching_deadline", enabled: true, threshold: null },
      { kind: "stale_task", enabled: true, threshold: 14 },
      { kind: "empty_today", enabled: true, threshold: null },
      { kind: "overloaded_day", enabled: true, threshold: null },
    ],
  },
  keyboard_shortcuts: [
    { action: "quick-add", chord: "cmd+a" },
    { action: "search", chord: "cmd+k" },
    { action: "command-palette", chord: "cmd+shift+p" },
    { action: "new-project", chord: "g n" },
    { action: "undo", chord: "cmd+z" },
    { action: "redo", chord: "cmd+shift+z" },
    { action: "today", chord: "g t" },
    { action: "inbox", chord: "g i" },
    { action: "upcoming", chord: "g u" },
    { action: "someday", chord: "g s" },
    { action: "completed", chord: "g c" },
    { action: "cancelled", chord: "g x" },
    { action: "filters", chord: "g f" },
    { action: "focus-mode", chord: "cmd+shift+f" },
    { action: "plan-my-day", chord: "g p" },
    { action: "end-of-day", chord: "g e" },
    { action: "weekly-review", chord: "g w" },
  ],
});

vi.mock("../../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    settings: settingsSnapshot,
    settingsLoading: false,
    settingsError: null,
    refreshSettings: vi.fn(),
    saveSettings,
    catalog: {
      templates: [],
      tags: [],
      projects: [],
      sections: [],
      saved_filters: [],
      revision: 1,
    },
    catalogLoading: false,
    catalogError: null,
    refreshCatalog: vi.fn(),
    mutationPhase: "idle",
    mutationError: null,
    revision: 1,
    registerTaskEventHandler: () => () => undefined,
  }),
}));

vi.mock("../../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    patchTask: vi.fn(),
    deleteTask: (...args: unknown[]) => deleteTask(...args),
    completeTask: vi.fn(),
    uncompleteTask: vi.fn(),
    cancelTask: vi.fn(),
    reopenTask: vi.fn(),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    addRelation: vi.fn(),
    removeRelation: vi.fn(),
    rescheduleReminder: vi.fn(),
    dismissReminder: vi.fn(),
  }),
}));

vi.mock("../../hooks/useComments", () => ({
  useComments: () => ({ comments: [], loading: false, reload: vi.fn() }),
}));
vi.mock("../../hooks/useRelations", () => ({
  useRelations: () => ({ blocks: [], blockedBy: [], reload: vi.fn() }),
}));
vi.mock("../../hooks/useTaskActivity", () => ({
  useTaskActivity: () => ({ activity: [], reload: vi.fn() }),
}));

function mutationOk(): MutationResponse {
  return {
    event: {
      revision: 2,
      operation_id: "11111111-1111-4111-8111-111111111111",
      event_type: "task.deleted",
      occurred_at: "2026-07-23T10:01:00Z",
      affected: { task_ids: [] },
      resync: { tasks: true, catalog: false, settings: false },
    },
  } as unknown as MutationResponse;
}

function makeTask(): TaskDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Delete me",
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision: 1,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    due_date: "2026-07-23",
  } as TaskDto;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("settings parity integrations", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    settingsSnapshot = baseSettings();
    saveSettings.mockReset().mockImplementation(async (patch: Partial<AppSettingsResponse>) => {
      settingsSnapshot = {
        ...settingsSnapshot,
        ...patch,
        appearance: { ...settingsSnapshot.appearance, ...(patch.appearance ?? {}) },
        features: { ...settingsSnapshot.features, ...(patch.features ?? {}) },
        task_defaults: { ...settingsSnapshot.task_defaults, ...(patch.task_defaults ?? {}) },
        keyboard_shortcuts: patch.keyboard_shortcuts ?? settingsSnapshot.keyboard_shortcuts,
      };
      return mutationOk();
    });
    deleteTask.mockReset().mockResolvedValue(mutationOk());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("records keyboard conflicts without saving and accepts a free rebind", async () => {
    act(() => {
      root.render(createElement(KeyboardTab));
    });
    const editButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.textContent === "Edit",
    );
    // First Edit is quick-add; second is search.
    act(() => {
      editButtons[1]!.click();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent ?? "").toMatch(/already used/i);
    expect(saveSettings).not.toHaveBeenCalled();

    const editAgain = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.textContent === "Edit",
    );
    act(() => {
      editAgain[1]!.click();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(saveSettings).toHaveBeenCalled();
    const payload = saveSettings.mock.calls.at(-1)?.[0] as {
      keyboard_shortcuts: Array<{ action: string; chord: string }>;
    };
    expect(payload.keyboard_shortcuts.find((row) => row.action === "search")?.chord).toBe(
      "cmd+shift+k",
    );
  });

  it("records a two-key chord after a pending first key", async () => {
    vi.useFakeTimers();
    act(() => {
      root.render(createElement(KeyboardTab));
    });
    const editButtons = Array.from(container.querySelectorAll("button")).filter(
      (btn) => btn.textContent === "Edit",
    );
    // new-project default is `g n` — rebind via two plain keys.
    const newProjectEdit = editButtons[3]!;
    act(() => {
      newProjectEdit.click();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "h",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.textContent).toMatch(/H then/i);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(saveSettings).toHaveBeenCalled();
    const payload = saveSettings.mock.calls.at(-1)?.[0] as {
      keyboard_shortcuts: Array<{ action: string; chord: string }>;
    };
    expect(payload.keyboard_shortcuts.find((row) => row.action === "new-project")?.chord).toBe(
      "h p",
    );
    vi.useRealTimers();
  });

  it("cancels an unfinished two-key recording after the timeout", () => {
    vi.useFakeTimers();
    act(() => {
      root.render(createElement(KeyboardTab));
    });
    const edit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    )!;
    act(() => {
      edit.click();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "h",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.textContent).toMatch(/H then/i);

    act(() => {
      vi.advanceTimersByTime(TWO_KEY_CHORD_TIMEOUT_MS);
    });

    expect(container.textContent).toMatch(/timed out/i);
    expect(container.textContent).not.toMatch(/H then/i);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("owns templates inside Settings and points Quick Add there", () => {
    act(() => {
      root.render(createElement(TemplatesTab));
    });
    expect(container.textContent).toContain("Templates");

    const onManage = vi.fn();
    act(() => {
      root.render(
        createElement(QuickAddModal, {
          open: true,
          onClose: vi.fn(),
          onManageTemplates: onManage,
        }),
      );
    });
    const templatesToggle = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Templates",
    ) as HTMLButtonElement;
    act(() => {
      templatesToggle.click();
    });
    const manage = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Manage templates in Settings"),
    ) as HTMLButtonElement;
    expect(manage).toBeTruthy();
    act(() => {
      manage.click();
    });
    expect(onManage).toHaveBeenCalled();
  });

  it("hides TaskDetail focus action when focus mode is disabled", () => {
    settingsSnapshot.features.focus_mode_enabled = false;
    act(() => {
      root.render(
        createElement(TaskDetailPanel, {
          task: makeTask(),
          onClose: vi.fn(),
          onEnterFocusMode: vi.fn(),
        }),
      );
    });
    expect(container.querySelector('button[aria-label="Enter Focus Mode"]')).toBeNull();
  });

  it("deletes directly when confirm_before_delete is false", async () => {
    settingsSnapshot.task_defaults.confirm_before_delete = false;
    act(() => {
      root.render(
        createElement(TaskDetailPanel, {
          task: makeTask(),
          onClose: vi.fn(),
        }),
      );
    });
    const del = container.querySelector('button[aria-label="Delete task"]') as HTMLButtonElement;
    act(() => {
      del.click();
    });
    await flush();
    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("uses ConfirmDialog when confirm_before_delete is true", async () => {
    settingsSnapshot.task_defaults.confirm_before_delete = true;
    act(() => {
      root.render(
        createElement(TaskDetailPanel, {
          task: makeTask(),
          onClose: vi.fn(),
        }),
      );
    });
    const del = container.querySelector('button[aria-label="Delete task"]') as HTMLButtonElement;
    act(() => {
      del.click();
    });
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(deleteTask).not.toHaveBeenCalled();
    const confirm = container.querySelector(
      '[role="alertdialog"] button[aria-label="Delete task"]',
    ) as HTMLButtonElement;
    act(() => {
      confirm.click();
    });
    await flush();
    expect(deleteTask).toHaveBeenCalledTimes(1);
  });
});
