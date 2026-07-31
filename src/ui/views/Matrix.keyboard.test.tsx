/**
 * Matrix keyboard move menu — native React DOM test (no Testing Library).
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "../api/client";
import { Matrix } from "./Matrix";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const patchTask = vi.fn();
const reload = vi.fn();

vi.mock("../hooks/useViewTasks", () => ({
  useViewTasks: () => ({
    tasks: [
      {
        id: "task-1",
        title: "Urgent important",
        description: "",
        someday: false,
        tag_ids: [],
        sort_order: 0,
        status: "pending",
        priority: 1,
        due_date: "2026-07-23",
        created_at: "2026-07-23T00:00:00Z",
        updated_at: "2026-07-23T00:00:00Z",
        revision: 1,
      } satisfies TaskDto,
    ],
    loading: false,
    error: null,
    reload,
    revision: 1,
    asOfDate: "2026-07-23",
    nextCursor: null,
    loadingMore: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({ patchTask }),
}));

vi.mock("../hooks/useToday", () => ({
  useToday: () => "2026-07-23",
}));

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactElement) {
  act(() => {
    root.render(ui);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  patchTask.mockReset();
  reload.mockReset();
  patchTask.mockResolvedValue({ event: { revision: 2 } });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("Matrix keyboard move", () => {
  it("moves a task through the keyboard menu and awaits the mutation", async () => {
    render(
      createElement(Matrix, {
        onToggleTask: async () => true,
        onSelectTask: () => {},
        selectedTaskId: null,
      }),
    );

    const moveBtn = container.querySelector(
      'button[aria-label="Move task Urgent important"]',
    ) as HTMLButtonElement;
    expect(moveBtn).toBeTruthy();

    await act(async () => {
      moveBtn.click();
    });

    const schedule = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Schedule"),
    ) as HTMLButtonElement;
    expect(schedule).toBeTruthy();

    await act(async () => {
      schedule.click();
    });

    expect(patchTask).toHaveBeenCalledWith(
      "task-1",
      { priority: 1, due_date: null },
      "Move matrix task",
    );
    expect(reload).toHaveBeenCalled();
  });

  it("surfaces an accessible error when the awaited move fails", async () => {
    patchTask.mockResolvedValue(null);

    render(
      createElement(Matrix, {
        onToggleTask: async () => true,
        onSelectTask: () => {},
        selectedTaskId: null,
      }),
    );

    const moveBtn = container.querySelector(
      'button[aria-label="Move task Urgent important"]',
    ) as HTMLButtonElement;

    await act(async () => {
      moveBtn.click();
    });

    const eliminate = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Eliminate"),
    ) as HTMLButtonElement;

    await act(async () => {
      eliminate.click();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The task could not be moved.");
  });
});
