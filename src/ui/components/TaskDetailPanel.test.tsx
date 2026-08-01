import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationResponse, TaskDto } from "../api/client";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { buildTaskPatch } from "./taskDraft";

// React 19 act() requires this flag outside @testing-library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const testEnvironment = (
  globalThis as unknown as {
    process: { env: Record<string, string | undefined> };
  }
).process.env;

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const patchTask = vi.fn<(taskId: string, body: unknown) => Promise<MutationResponse | null>>();
const deleteTask = vi.fn<(taskId: string) => Promise<MutationResponse | null>>();
const completeTask = vi.fn();
const uncompleteTask = vi.fn();
const cancelTask = vi.fn();
const reopenTask = vi.fn();
const createTask = vi.fn();
const moveTask = vi.fn();
const addRelation = vi.fn();
const removeRelation = vi.fn();
const getTask = vi.fn();
const listTasks = vi.fn();
const reloadRelations = vi.fn();
const reloadComments = vi.fn();
const reloadActivity = vi.fn();
const createComment = vi.fn();
const patchComment = vi.fn();
const deleteComment = vi.fn();
const rescheduleReminder = vi.fn();
const dismissReminder = vi.fn();
const listTaskReminders = vi.fn();

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    patchTask: (...args: [string, unknown]) => patchTask(...args),
    deleteTask: (...args: [string]) => deleteTask(...args),
    completeTask: (...args: unknown[]) => completeTask(...args),
    uncompleteTask: (...args: unknown[]) => uncompleteTask(...args),
    cancelTask: (...args: unknown[]) => cancelTask(...args),
    reopenTask: (...args: unknown[]) => reopenTask(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    moveTask: (...args: unknown[]) => moveTask(...args),
    addRelation: (...args: unknown[]) => addRelation(...args),
    removeRelation: (...args: unknown[]) => removeRelation(...args),
    rescheduleReminder: (...args: unknown[]) => rescheduleReminder(...args),
    dismissReminder: (...args: unknown[]) => dismissReminder(...args),
  }),
}));

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    catalog: {
      projects: [],
      sections: [],
      tags: [],
      templates: [],
      saved_filters: [],
      revision: 1,
    },
    mutationPhase: "idle",
    mutationError: null,
    undo: vi.fn(),
    canUndo: false,
    undoStack: [],
    revision: 1,
  }),
}));

let mockBlocks: Array<{ from_task_id: string; to_task_id: string; kind: string }> = [];
let mockBlockedBy: Array<{ from_task_id: string; to_task_id: string; kind: string }> = [];

vi.mock("../hooks/useTaskDetail", () => ({
  useComments: () => ({
    comments: [],
    loading: "ready",
    reload: (...args: unknown[]) => reloadComments(...args),
  }),
  useRelations: () => ({
    blocks: mockBlocks,
    blockedBy: mockBlockedBy,
    loading: "ready",
    reload: (...args: unknown[]) => reloadRelations(...args),
  }),
  useTaskActivity: () => ({
    activity: [],
    loading: "ready",
    reload: (...args: unknown[]) => reloadActivity(...args),
  }),
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getTask: (...args: unknown[]) => getTask(...args),
    listTasks: (...args: unknown[]) => listTasks(...args),
    createComment: (...args: unknown[]) => createComment(...args),
    patchComment: (...args: unknown[]) => patchComment(...args),
    deleteComment: (...args: unknown[]) => deleteComment(...args),
    listTaskReminders: (...args: unknown[]) => listTaskReminders(...args),
    generateOperationId: () => "op-test",
  };
});

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Sample task",
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision: 1,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    due_date: "2026-07-23",
    ...overrides,
  };
}

function mutationOk(): MutationResponse {
  return {
    event: {
      revision: 2,
      operation_id: "op-test",
      event_type: "task.updated",
      occurred_at: "2026-07-23T10:01:00Z",
      affected: { task_ids: [] },
      resync: { tasks: false, catalog: false },
    },
  };
}

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactElement) {
  act(() => {
    root.render(ui);
  });
}

function Host({ task }: { task: TaskDto }) {
  const [open, setOpen] = useState(true);
  if (!open) {
    return createElement("button", { type: "button", id: "opener" }, "Opener");
  }
  return createElement(TaskDetailPanel, {
    task,
    onClose: () => setOpen(false),
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockBlocks = [];
  mockBlockedBy = [];
  patchTask.mockReset().mockResolvedValue(mutationOk());
  deleteTask.mockReset().mockResolvedValue(mutationOk());
  completeTask.mockReset();
  uncompleteTask.mockReset();
  cancelTask.mockReset();
  reopenTask.mockReset();
  createTask.mockReset().mockResolvedValue(mutationOk());
  moveTask.mockReset().mockResolvedValue(mutationOk());
  addRelation.mockReset().mockResolvedValue(mutationOk());
  removeRelation.mockReset().mockResolvedValue(mutationOk());
  reloadRelations.mockReset();
  reloadComments.mockReset();
  reloadActivity.mockReset();
  createComment.mockReset().mockResolvedValue(mutationOk());
  patchComment.mockReset().mockResolvedValue(mutationOk());
  deleteComment.mockReset().mockResolvedValue(mutationOk());
  getTask.mockReset().mockImplementation(async (id: string) => {
    if (id === "22222222-2222-4222-8222-222222222222") {
      return makeTask({ id, title: "Parent task" });
    }
    if (id === "33333333-3333-4333-8333-333333333333") {
      return makeTask({ id, title: "Blocking task" });
    }
    throw new Error("none");
  });
  listTasks.mockReset().mockResolvedValue({
    tasks: [],
    revision: 1,
    as_of_date: "2026-07-23",
    next_cursor: null,
  });
  listTaskReminders.mockReset().mockResolvedValue({ reminders: [] });
  rescheduleReminder.mockReset().mockResolvedValue(mutationOk());
  dismissReminder.mockReset().mockResolvedValue(mutationOk());
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("buildTaskPatch", () => {
  it("includes only changed fields and clears due_date with null", () => {
    const task = makeTask({ due_date: "2026-07-23", priority: 2, description: "old" });
    const draft = {
      title: "Sample task",
      description: "new body",
      priority: 2,
      due_date: "",
      deadline: "",
      someday: false,
      estimated_minutes: "",
      actual_minutes: "",
      dread: null,
      project_id: "",
      section_id: "",
      parent_id: "",
      tag_ids: [] as string[],
      recurrence_rule: "",
    };
    expect(buildTaskPatch(task, draft)).toEqual({
      description: "new body",
      due_date: null,
    });
  });

  it("returns null when nothing changed", () => {
    const task = makeTask();
    const draft = {
      title: task.title,
      description: task.description,
      priority: task.priority ?? null,
      due_date: task.due_date ?? "",
      deadline: "",
      someday: task.someday,
      estimated_minutes: "",
      actual_minutes: "",
      dread: null,
      project_id: "",
      section_id: "",
      parent_id: "",
      tag_ids: [] as string[],
      recurrence_rule: "",
    };
    expect(buildTaskPatch(task, draft)).toBeNull();
  });
});

describe("TaskDetailPanel", () => {
  it("keeps unsaved draft and comment text when an unrelated committed snapshot arrives (P2-FE-001)", async () => {
    const initial = makeTask({ title: "Sample task", revision: 1 });
    function DetailHost() {
      const [task, setTask] = useState(initial);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            type: "button",
            id: "push-remote",
            onClick: () =>
              setTask(
                makeTask({
                  title: "Remote title",
                  description: "remote body",
                  revision: 2,
                  updated_at: "2026-07-23T11:00:00Z",
                }),
              ),
          },
          "push",
        ),
        createElement(TaskDetailPanel, { task, onClose: () => {} }),
      );
    }

    render(createElement(DetailHost));

    const title = container.querySelector('input[aria-label="Task title"]') as HTMLInputElement;
    const comment = container.querySelector(
      'input[placeholder="Add a comment…"]',
    ) as HTMLInputElement;

    await act(async () => {
      setInputValue(title, "Local unsaved title");
      setInputValue(comment, "Draft comment text");
    });

    await act(async () => {
      (container.querySelector("#push-remote") as HTMLButtonElement).click();
    });

    expect(
      (container.querySelector('input[aria-label="Task title"]') as HTMLInputElement).value,
    ).toBe("Local unsaved title");
    expect(
      (container.querySelector('input[placeholder="Add a comment…"]') as HTMLInputElement).value,
    ).toBe("Draft comment text");
    expect(container.textContent).toContain("This task changed elsewhere");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("shows stale notice on dirty same-task remote change and Reload restores committed fields (P2-FE-001)", async () => {
    const initial = makeTask({ title: "Original", revision: 1 });
    function DetailHost() {
      const [task, setTask] = useState(initial);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            type: "button",
            id: "push-remote",
            onClick: () =>
              setTask(
                makeTask({
                  title: "Server wins",
                  revision: 3,
                  updated_at: "2026-07-23T12:00:00Z",
                }),
              ),
          },
          "push",
        ),
        createElement(TaskDetailPanel, { task, onClose: () => {} }),
      );
    }

    render(createElement(DetailHost));

    const title = container.querySelector('input[aria-label="Task title"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(title, "My local edit");
    });

    await act(async () => {
      (container.querySelector("#push-remote") as HTMLButtonElement).click();
    });

    expect(
      (container.querySelector('input[aria-label="Task title"]') as HTMLInputElement).value,
    ).toBe("My local edit");
    const reload = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Reload",
    ) as HTMLButtonElement;
    expect(reload).toBeTruthy();

    await act(async () => {
      reload.click();
    });

    expect(
      (container.querySelector('input[aria-label="Task title"]') as HTMLInputElement).value,
    ).toBe("Server wins");
    expect(container.textContent).not.toContain("This task changed elsewhere");
  });

  it("saves all draft field changes in one PATCH when Save is pressed", async () => {
    render(createElement(Host, { task: makeTask({ due_date: "2026-07-23", priority: null }) }));

    const title = container.querySelector('input[aria-label="Task title"]') as HTMLInputElement;
    const due = container.querySelector("#task-due-date") as HTMLInputElement;
    const priorityP1 = container.querySelector(
      'button[aria-label="Priority P1"]',
    ) as HTMLButtonElement;
    const save = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save changes",
    ) as HTMLButtonElement;

    await act(async () => {
      setInputValue(title, "Renamed task");
      setInputValue(due, "2026-08-01");
      priorityP1.click();
    });

    expect(patchTask).not.toHaveBeenCalled();

    await act(async () => {
      save.click();
    });

    expect(patchTask).toHaveBeenCalledTimes(1);
    expect(patchTask).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      title: "Renamed task",
      due_date: "2026-08-01",
      priority: 1,
    });
  });

  it("clears due date in the draft and sends null on Save", async () => {
    render(createElement(Host, { task: makeTask({ due_date: "2026-07-23" }) }));

    const clear = container.querySelector(
      'button[aria-label="Clear due date"]',
    ) as HTMLButtonElement;
    const save = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save changes",
    ) as HTMLButtonElement;

    await act(async () => {
      clear.click();
    });
    expect((container.querySelector("#task-due-date") as HTMLInputElement).value).toBe("");
    expect(patchTask).not.toHaveBeenCalled();

    await act(async () => {
      save.click();
    });

    expect(patchTask).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      due_date: null,
    });
  });

  it("closes on Escape and restores focus to the opener", async () => {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    render(createElement(Host, { task: makeTask() }));
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("exposes recurrence controls with canonical labels", async () => {
    await act(async () => {
      root.render(createElement(Host, { task: makeTask({ recurrence_rule: "weekly" }) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toMatch(/Recurrence/i);
    expect(container.textContent).toMatch(/Weekly/);
    expect(container.textContent).toMatch(/Reminder/i);
  });

  it("displays and round-trips a UTC reminder in browser-local time", async () => {
    const originalTimeZone = testEnvironment.TZ;
    try {
      testEnvironment.TZ = "America/Los_Angeles";
      const task = makeTask({ remind_at: "2026-07-15T18:45:00.000Z" });
      getTask.mockResolvedValue(task);
      render(createElement(Host, { task }));

      await act(async () => {
        (
          container.querySelector('button[aria-label="Edit reminder"]') as HTMLButtonElement
        ).click();
      });
      const input = container.querySelector(
        'input[aria-label="Edit reminder time"]',
      ) as HTMLInputElement;
      expect(input.value).toBe("2026-07-15T11:45");

      await act(async () => {
        const schedule = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Schedule",
        ) as HTMLButtonElement;
        schedule.click();
        await Promise.resolve();
      });

      expect(rescheduleReminder).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        "2026-07-15T18:45:00.000Z",
      );
    } finally {
      if (originalTimeZone === undefined) delete testEnvironment.TZ;
      else testEnvironment.TZ = originalTimeZone;
    }
  });

  it("round-trips an offset reminder during the repeated DST hour", async () => {
    const originalTimeZone = testEnvironment.TZ;
    try {
      testEnvironment.TZ = "America/Los_Angeles";
      const task = makeTask({ remind_at: "2026-11-01T01:30:00-08:00" });
      getTask.mockResolvedValue(task);
      render(createElement(Host, { task }));

      await act(async () => {
        (
          container.querySelector('button[aria-label="Edit reminder"]') as HTMLButtonElement
        ).click();
      });
      const input = container.querySelector(
        'input[aria-label="Edit reminder time"]',
      ) as HTMLInputElement;
      expect(input.value).toBe("2026-11-01T01:30");

      await act(async () => {
        const schedule = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Schedule",
        ) as HTMLButtonElement;
        schedule.click();
        await Promise.resolve();
      });

      expect(rescheduleReminder).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        "2026-11-01T09:30:00.000Z",
      );
    } finally {
      if (originalTimeZone === undefined) delete testEnvironment.TZ;
      else testEnvironment.TZ = originalTimeZone;
    }
  });

  it("uses the wide two-column desktop detail structure with accessible naming", async () => {
    render(
      createElement(Host, {
        task: makeTask({
          title: "Ship docs",
          recurrence_rule: "weekly",
          remind_at: "2026-12-15T15:00:00.000Z",
          estimated_minutes: 120,
        }),
      }),
    );

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute("aria-label")).toBe("Task: Ship docs");
    expect(container.querySelector('[data-testid="task-detail-surface"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="task-detail-scroll-region"]')).toBeTruthy();
    expect(container.querySelector("aside.scrollbar-panel")).toBeTruthy();

    // Right-rail cards present
    expect(container.textContent).toMatch(/Deadline/i);
    expect(container.textContent).toMatch(/Priority/i);
    expect(container.textContent).toMatch(/Labels/i);
    expect(container.textContent).toMatch(/Estimated time/i);
    expect(container.textContent).toMatch(/Delete task/);
    expect(container.textContent).toMatch(/Sub-tasks/i);
    expect(container.textContent).toMatch(/Relations/i);
    expect(container.textContent).toMatch(/Comments/);

    // Reminder display value (legacy card presentation)
    expect(container.querySelector('button[aria-label="Edit reminder"]')).toBeTruthy();
    expect(container.textContent).toMatch(/Weekly/);
    expect(container.textContent).toMatch(/2h/);

    // The retained legacy chevrons are visibly present but truthfully unavailable.
    expect(
      (container.querySelector('button[aria-label="Previous task"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (container.querySelector('button[aria-label="Next task"]') as HTMLButtonElement).disabled,
    ).toBe(true);

    // Close control retained
    expect(container.querySelector('button[aria-label="Close task details"]')).toBeTruthy();
  });

  it("asks for in-product confirmation before deleting", async () => {
    render(createElement(Host, { task: makeTask() }));

    const deleteBtn = container.querySelector(
      'button[aria-label="Delete task"]',
    ) as HTMLButtonElement;
    await act(async () => {
      deleteBtn.click();
    });

    expect(deleteTask).not.toHaveBeenCalled();
    const confirm = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain("Delete task?");

    const confirmBtn = Array.from(confirm.querySelectorAll("button")).find((btn) =>
      btn.getAttribute("aria-label")?.includes("Delete task"),
    ) as HTMLButtonElement;

    await act(async () => {
      confirmBtn.click();
    });

    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(deleteTask).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("sets parent via focused search without destroying a dirty draft (P2-FE-008)", async () => {
    const parentId = "22222222-2222-4222-8222-222222222222";
    listTasks.mockImplementation(async (params?: { search?: string; parent_id?: string }) => {
      if (params?.search) {
        return {
          tasks: [makeTask({ id: parentId, title: "Chosen parent" })],
          revision: 1,
          as_of_date: "2026-07-23",
          next_cursor: null,
        };
      }
      return { tasks: [], revision: 1, as_of_date: "2026-07-23", next_cursor: null };
    });

    render(createElement(Host, { task: makeTask() }));

    const title = container.querySelector('input[aria-label="Task title"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(title, "Local draft title");
    });

    const setParentBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Set parent"),
    ) as HTMLButtonElement;
    await act(async () => {
      setParentBtn.click();
    });

    const search = container.querySelector("#parent-search") as HTMLInputElement;
    await act(async () => {
      setInputValue(search, "Chosen");
      await new Promise((r) => setTimeout(r, 250));
    });

    const option = Array.from(container.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes("Chosen parent"),
    ) as HTMLButtonElement;
    expect(option).toBeTruthy();

    await act(async () => {
      option.click();
    });

    expect(moveTask).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      parent_id: parentId,
      order: "last",
    });
    expect(
      (container.querySelector('input[aria-label="Task title"]') as HTMLInputElement).value,
    ).toBe("Local draft title");
    expect(patchTask).not.toHaveBeenCalled();
  });

  it("creates a subtask with parent_id through create mutation (P2-FE-008)", async () => {
    render(createElement(Host, { task: makeTask() }));

    const input = container.querySelector("#new-subtask-title") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "Child work");
    });

    const addBtn = container.querySelector('button[aria-label="Add subtask"]') as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
    });

    expect(createTask).toHaveBeenCalledWith({
      title: "Child work",
      parent_id: "11111111-1111-4111-8111-111111111111",
      project_id: null,
      section_id: null,
    });
  });

  it("resolves relation titles and supports add/remove (P2-FE-008)", async () => {
    const otherId = "33333333-3333-4333-8333-333333333333";
    mockBlocks = [
      {
        from_task_id: "11111111-1111-4111-8111-111111111111",
        to_task_id: otherId,
        kind: "blocks",
      },
    ];

    listTasks.mockImplementation(async (params?: { search?: string }) => {
      if (params?.search) {
        return {
          tasks: [makeTask({ id: "44444444-4444-4444-8444-444444444444", title: "New blocker" })],
          revision: 1,
          as_of_date: "2026-07-23",
          next_cursor: null,
        };
      }
      return { tasks: [], revision: 1, as_of_date: "2026-07-23", next_cursor: null };
    });

    render(createElement(Host, { task: makeTask() }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain("Blocking task");
    expect(container.textContent).not.toContain(otherId);

    const removeBtn = container.querySelector(
      `button[aria-label="Remove blocks relation to Blocking task"]`,
    ) as HTMLButtonElement;
    await act(async () => {
      removeBtn.click();
    });
    expect(removeRelation).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", otherId);

    const addBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Add relation"),
    ) as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
    });

    const search = container.querySelector("#relation-search") as HTMLInputElement;
    await act(async () => {
      setInputValue(search, "New");
      await new Promise((r) => setTimeout(r, 250));
    });

    const option = Array.from(container.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes("New blocker"),
    ) as HTMLButtonElement;
    await act(async () => {
      option.click();
    });

    expect(addRelation).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      kind: "blocks",
      to_task_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(reloadActivity).toHaveBeenCalled();
  });

  it("refreshes activity after adding a comment and when selecting the Activity tab", async () => {
    render(createElement(Host, { task: makeTask() }));

    const comment = container.querySelector(
      'input[placeholder="Add a comment…"]',
    ) as HTMLInputElement;
    const draftTitle = container.querySelector(
      'input[aria-label="Task title"]',
    ) as HTMLInputElement;

    await act(async () => {
      setInputValue(draftTitle, "Unsaved draft title");
      setInputValue(comment, "Fresh comment");
    });

    const addComment = container.querySelector(
      'button[aria-label="Add comment"]',
    ) as HTMLButtonElement;
    reloadActivity.mockClear();
    reloadComments.mockClear();

    await act(async () => {
      addComment.click();
      await Promise.resolve();
    });

    expect(createComment).toHaveBeenCalled();
    expect(reloadComments).toHaveBeenCalled();
    expect(reloadActivity).toHaveBeenCalled();
    // Dirty draft is preserved across the comment/activity refresh.
    expect(
      (container.querySelector('input[aria-label="Task title"]') as HTMLInputElement).value,
    ).toBe("Unsaved draft title");

    reloadActivity.mockClear();
    const activityTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.textContent?.trim() === "Activity",
    ) as HTMLButtonElement;
    await act(async () => {
      activityTab.click();
    });
    expect(reloadActivity).toHaveBeenCalled();
    expect(
      (container.querySelector('input[aria-label="Task title"]') as HTMLInputElement).value,
    ).toBe("Unsaved draft title");
  });

  it("refreshes activity after removing a relation", async () => {
    const otherId = "33333333-3333-4333-8333-333333333333";
    mockBlocks = [
      {
        from_task_id: "11111111-1111-4111-8111-111111111111",
        to_task_id: otherId,
        kind: "blocks",
      },
    ];
    render(createElement(Host, { task: makeTask() }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    reloadActivity.mockClear();
    const removeBtn = container.querySelector(
      `button[aria-label="Remove blocks relation to Blocking task"]`,
    ) as HTMLButtonElement;
    await act(async () => {
      removeBtn.click();
    });
    expect(removeRelation).toHaveBeenCalled();
    expect(reloadActivity).toHaveBeenCalled();
  });
});
