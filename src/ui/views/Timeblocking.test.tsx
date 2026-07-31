/**
 * Timeblocking view tests — fake DOM geometry/timers, no browser screenshots.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MutationResponse,
  TemporalSettingsResponse,
  TimeBlockDto,
  TimeSlotDto,
} from "../api/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listTimeBlocks = vi.fn();
const listTimeSlots = vi.fn();
const getTemporalSettings = vi.fn();
const createTimeBlock = vi.fn();
const patchTimeBlock = vi.fn();
const deleteTimeBlock = vi.fn();
const moveTimeBlock = vi.fn();
const resizeTimeBlock = vi.fn();
const replanTimeBlocks = vi.fn();
const createTimeSlot = vi.fn();
const patchTimeSlot = vi.fn();
const deleteTimeSlot = vi.fn();
const replaceTimeSlotTasks = vi.fn();
const appendTimeSlotTask = vi.fn();
const removeTimeSlotTask = vi.fn();
const runMutation = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    listTimeBlocks: (...args: unknown[]) => listTimeBlocks(...args),
    listTimeSlots: (...args: unknown[]) => listTimeSlots(...args),
    getTemporalSettings: (...args: unknown[]) => getTemporalSettings(...args),
    createTimeBlock: (...args: unknown[]) => createTimeBlock(...args),
    patchTimeBlock: (...args: unknown[]) => patchTimeBlock(...args),
    deleteTimeBlock: (...args: unknown[]) => deleteTimeBlock(...args),
    moveTimeBlock: (...args: unknown[]) => moveTimeBlock(...args),
    resizeTimeBlock: (...args: unknown[]) => resizeTimeBlock(...args),
    replanTimeBlocks: (...args: unknown[]) => replanTimeBlocks(...args),
    createTimeSlot: (...args: unknown[]) => createTimeSlot(...args),
    patchTimeSlot: (...args: unknown[]) => patchTimeSlot(...args),
    deleteTimeSlot: (...args: unknown[]) => deleteTimeSlot(...args),
    replaceTimeSlotTasks: (...args: unknown[]) => replaceTimeSlotTasks(...args),
    appendTimeSlotTask: (...args: unknown[]) => appendTimeSlotTask(...args),
    removeTimeSlotTask: (...args: unknown[]) => removeTimeSlotTask(...args),
  };
});

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    catalog: {
      projects: [
        {
          id: "proj-1",
          name: "Website",
          color: "#6366f1",
          archived: false,
          favorite: false,
          sort_order: 0,
          created_at: "2026-07-23T00:00:00Z",
          updated_at: "2026-07-23T00:00:00Z",
          revision: 1,
        },
      ],
      sections: [],
      tags: [],
      saved_filters: [],
      templates: [],
      revision: 1,
    },
    catalogLoading: false,
    catalogError: null,
    refreshCatalog: vi.fn(),
    mutationPhase: "idle",
    mutationError: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    toasts: [],
    showToast: vi.fn(),
    dismissToast: vi.fn(),
    sseError: null,
    registerTaskEventHandler: () => () => {},
    registerTaskResyncHandler: () => () => {},
    runMutation,
    revision: 1,
  }),
}));

vi.mock("../hooks/useViewTasks", () => ({
  useViewTasks: () => ({
    tasks: [
      {
        id: "task-1",
        title: "Deep work",
        description: "",
        someday: false,
        tag_ids: [],
        sort_order: 0,
        status: "pending",
        priority: 1,
        due_date: "2026-07-23",
        estimated_minutes: 90,
        project_id: "proj-1",
        created_at: "2026-07-23T00:00:00Z",
        updated_at: "2026-07-23T00:00:00Z",
        revision: 1,
      },
      {
        id: "task-2",
        title: "Review comments",
        description: "",
        someday: false,
        tag_ids: [],
        sort_order: 1,
        status: "pending",
        priority: 2,
        due_date: "2026-07-23",
        estimated_minutes: 30,
        project_id: "proj-1",
        created_at: "2026-07-23T00:00:00Z",
        updated_at: "2026-07-23T00:00:00Z",
        revision: 1,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    revision: 1,
    asOfDate: "2026-07-23",
    nextCursor: null,
    loadingMore: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    completeTask: vi.fn(),
    uncompleteTask: vi.fn(),
    patchTask: vi.fn(),
  }),
}));

import { Timeblocking } from "./Timeblocking";

function mutationResponse(): MutationResponse {
  return {
    event: {
      event_type: "time_block.updated",
      operation_id: "op-1",
      revision: 2,
      occurred_at: "2026-07-23T12:00:00Z",
      affected: {},
      resync: { catalog: false, tasks: false },
    },
  };
}

function block(
  partial: Partial<TimeBlockDto> & Pick<TimeBlockDto, "id" | "date" | "title">,
): TimeBlockDto {
  const date = partial.date;
  return {
    occurrence_key: partial.occurrence_key ?? `${partial.id}:${date}`,
    start: "09:00:00",
    end: "10:00:00",
    time_zone: "UTC",
    locked: false,
    created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:00:00Z",
    revision: 1,
    ...partial,
  };
}

function slot(
  partial: Partial<TimeSlotDto> & Pick<TimeSlotDto, "id" | "date" | "title">,
): TimeSlotDto {
  const date = partial.date;
  return {
    occurrence_key: partial.occurrence_key ?? `${partial.id}:${date}`,
    start: "13:00:00",
    end: "14:00:00",
    time_zone: "UTC",
    task_ids: [],
    created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:00:00Z",
    revision: 1,
    ...partial,
  };
}

const settings: TemporalSettingsResponse = {
  time_zone: "America/Los_Angeles",
  capacity_minutes: 480,
  week_start: "sunday",
  nudges_enabled: true,
  eat_the_frog_enabled: false,
  task_jar_enabled: false,
};

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactElement) {
  act(() => {
    root.render(ui);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 23, 10, 30, 0));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  listTimeBlocks.mockReset();
  listTimeSlots.mockReset();
  getTemporalSettings.mockReset();
  createTimeBlock.mockReset();
  patchTimeBlock.mockReset();
  deleteTimeBlock.mockReset();
  moveTimeBlock.mockReset();
  resizeTimeBlock.mockReset();
  replanTimeBlocks.mockReset();
  createTimeSlot.mockReset();
  patchTimeSlot.mockReset();
  deleteTimeSlot.mockReset();
  replaceTimeSlotTasks.mockReset();
  appendTimeSlotTask.mockReset();
  removeTimeSlotTask.mockReset();
  runMutation.mockReset();

  listTimeBlocks.mockImplementation(async (params?: { from?: string; to?: string }) => {
    if (params?.from === "2026-07-16" && params?.to === "2026-07-22") {
      return {
        revision: 1,
        time_blocks: [
          block({
            id: "stale-1",
            date: "2026-07-21",
            title: "Past unlocked",
            locked: false,
            start: "10:00:00",
            end: "11:00:00",
          }),
          block({
            id: "stale-locked",
            date: "2026-07-21",
            title: "Past locked",
            locked: true,
            start: "11:00:00",
            end: "12:00:00",
          }),
        ],
      };
    }
    return {
      revision: 1,
      time_blocks: [
        block({
          id: "block-1",
          date: "2026-07-23",
          title: "Deep work",
          start: "09:00:00",
          end: "10:30:00",
          task_id: "task-1",
          color: "#6366f1",
        }),
        block({
          id: "block-series",
          date: "2026-07-24",
          title: "Series instance",
          start: "11:00:00",
          end: "12:00:00",
          recurrence_rule: "daily",
          recurrence_parent_id: "block-series",
          occurrence_key: "block-series:2026-07-24",
        }),
      ],
    };
  });
  listTimeSlots.mockResolvedValue({
    revision: 1,
    time_slots: [
      slot({
        id: "slot-1",
        date: "2026-07-23",
        title: "Collaboration block",
        start: "13:00:00",
        end: "14:00:00",
        color: "#ec4899",
        task_ids: ["task-2", "task-1"],
      }),
    ],
  });
  getTemporalSettings.mockResolvedValue(settings);
  runMutation.mockImplementation(async (execute: (id: string) => Promise<MutationResponse>) => {
    return execute("op-test");
  });
  createTimeBlock.mockResolvedValue(mutationResponse());
  patchTimeBlock.mockResolvedValue(mutationResponse());
  deleteTimeBlock.mockResolvedValue(mutationResponse());
  moveTimeBlock.mockResolvedValue(mutationResponse());
  resizeTimeBlock.mockResolvedValue(mutationResponse());
  replanTimeBlocks.mockResolvedValue(mutationResponse());
  createTimeSlot.mockResolvedValue(mutationResponse());
  patchTimeSlot.mockResolvedValue(mutationResponse());
  deleteTimeSlot.mockResolvedValue(mutationResponse());
  replaceTimeSlotTasks.mockResolvedValue(mutationResponse());
  appendTimeSlotTask.mockResolvedValue(mutationResponse());
  removeTimeSlotTask.mockResolvedValue(mutationResponse());
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("Timeblocking view", () => {
  it("loads day range, settings defaults, stable keys, and narrow layout classes", async () => {
    render(createElement(Timeblocking, {}));
    await flush();

    expect(listTimeBlocks).toHaveBeenCalledWith({ from: "2026-07-23", to: "2026-07-23" });
    expect(listTimeSlots).toHaveBeenCalledWith({ date: "2026-07-23" });
    expect(getTemporalSettings).toHaveBeenCalled();

    const view = container.querySelector('[data-testid="timeblocking-view"]');
    expect(view).toBeTruthy();
    expect(view?.className).toContain("min-h-0");
    expect(view?.className).toMatch(/-m-3/);

    expect(container.querySelector('[data-testid="time-block-block-1:2026-07-23"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="time-slot-slot-1:2026-07-23"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="current-time-indicator"]')).toBeTruthy();

    const settingsBtn = container.querySelector(
      '[data-testid="tb-settings-trigger"]',
    ) as HTMLButtonElement;
    await act(async () => {
      settingsBtn.click();
    });
    expect(container.querySelector('[data-testid="tb-setting-capacity"]')?.textContent).toContain(
      "480",
    );
    expect(container.querySelector('[data-testid="tb-setting-start"]')?.textContent).toMatch(
      /9:00/,
    );
    expect(container.querySelector('[data-testid="tb-setting-end"]')?.textContent).toMatch(/5:00/);
  });

  it("switches to week range serialization", async () => {
    render(createElement(Timeblocking, {}));
    await flush();

    const weekRadio = container.querySelector(
      'input[type="radio"][value="week"]',
    ) as HTMLInputElement;
    await act(async () => {
      weekRadio.click();
    });
    await flush();

    expect(listTimeBlocks).toHaveBeenCalledWith({ from: "2026-07-23", to: "2026-07-29" });
    expect(
      container.querySelector('[data-testid="timeblocking-timeline"]')?.getAttribute("data-mode"),
    ).toBe("week");
    expect(container.querySelector('[data-testid="column-header-2026-07-23"]')).toBeTruthy();
  });

  it("creates, edits, moves, resizes, and deletes blocks with awaited mutations", async () => {
    render(createElement(Timeblocking, {}));
    await flush();

    const addBtn = container.querySelector('[data-testid="add-block-btn"]') as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
    });
    expect(container.querySelector('[data-testid="timeblocking-editor-dialog"]')).toBeTruthy();

    const title = container.querySelector('[data-testid="editor-title"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(title, "Planning");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = container.querySelector('[data-testid="editor-save"]') as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    await flush();
    expect(createTimeBlock).toHaveBeenCalled();
    const createArgs = createTimeBlock.mock.calls.at(-1)!;
    expect(createArgs[0]).toMatchObject({
      title: "Planning",
      date: "2026-07-23",
    });
    expect(createArgs[1]).toBe("op-test");

    const card = container.querySelector(
      '[data-testid="time-block-block-1:2026-07-23"]',
    ) as HTMLElement;
    await act(async () => {
      card.click();
    });
    const moveLater = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Move later"),
    ) as HTMLButtonElement;
    await act(async () => {
      moveLater.click();
      await Promise.resolve();
    });
    await flush();
    expect(moveTimeBlock).toHaveBeenCalled();
    expect(moveTimeBlock.mock.calls.at(-1)![0]).toBe("block-1");

    const endLater = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("End later"),
    ) as HTMLButtonElement;
    await act(async () => {
      endLater.click();
      await Promise.resolve();
    });
    await flush();
    expect(resizeTimeBlock).toHaveBeenCalled();

    const del = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Delete",
    ) as HTMLButtonElement;
    await act(async () => {
      del.click();
      await Promise.resolve();
    });
    await flush();
    expect(deleteTimeBlock).toHaveBeenCalledWith("block-1", "op-test");
  });

  it("labels series editing and mutates the owner id for virtual occurrences", async () => {
    render(createElement(Timeblocking, {}));
    await flush();

    // Switch to week so the virtual occurrence on Jul 24 is visible.
    const weekRadio = container.querySelector(
      'input[type="radio"][value="week"]',
    ) as HTMLInputElement;
    await act(async () => {
      weekRadio.click();
    });
    await flush();

    const seriesCard = container.querySelector(
      '[data-testid="time-block-block-series:2026-07-24"]',
    ) as HTMLElement;
    expect(seriesCard).toBeTruthy();
    await act(async () => {
      seriesCard.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="series-edit-notice"]')).toBeTruthy();

    const title = container.querySelector('[data-testid="editor-title"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(title, "Series renamed");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="editor-save"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await flush();
    expect(patchTimeBlock).toHaveBeenCalled();
    expect(patchTimeBlock.mock.calls.at(-1)![0]).toBe("block-series");
  });

  it("surfaces locked replan semantics and awaits replan failures", async () => {
    replanTimeBlocks.mockRejectedValueOnce(new Error("replan failed"));
    runMutation.mockImplementationOnce(
      async (execute: (id: string) => Promise<MutationResponse>) => {
        try {
          return await execute("op-fail");
        } catch {
          return null;
        }
      },
    );

    render(createElement(Timeblocking, {}));
    await flush();

    expect(container.querySelector('[data-testid="replan-banner"]')).toBeTruthy();
    expect(container.textContent).toContain("unlocked");

    await act(async () => {
      (container.querySelector('[data-testid="replan-open-btn"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="replan-action-move_to_today"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="replan-confirm-btn"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await flush();

    expect(replanTimeBlocks).toHaveBeenCalledWith({ action: "move_to_today" }, "op-fail");
    // Failure path leaves an error visible.
    expect(
      container.querySelector('[data-testid="timeblocking-error"], [role="alert"]'),
    ).toBeTruthy();
  });

  it("reorders slot membership through keyboard-equivalent controls", async () => {
    render(createElement(Timeblocking, {}));
    await flush();

    const later = container.querySelector(
      'button[aria-label="Move Review comments later in slot"]',
    ) as HTMLButtonElement;
    expect(later).toBeTruthy();
    await act(async () => {
      later.click();
      await Promise.resolve();
    });
    await flush();
    expect(replaceTimeSlotTasks).toHaveBeenCalledWith(
      "slot-1",
      { task_ids: ["task-1", "task-2"] },
      "op-test",
    );
  });

  it("exposes keyboard-equivalent selection controls for move/resize/delete", async () => {
    render(createElement(Timeblocking, {}));
    await flush();

    const card = container.querySelector(
      '[data-testid="time-block-block-1:2026-07-23"]',
    ) as HTMLElement;
    await act(async () => {
      card.click();
    });
    expect(container.querySelector('[data-testid="selection-keyboard-bar"]')).toBeTruthy();
    expect(container.textContent).toContain("Move earlier");
    expect(container.textContent).toContain("Start earlier");
    expect(container.textContent).toContain("End later");
  });
});
