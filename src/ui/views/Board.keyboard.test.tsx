/**
 * P2-FE-008: board move grip opens a keyboard-operable column menu.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto, SectionDto, TaskDto } from "../api/client";
import { Board, boardColumnOptions } from "./Board";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task-1",
    title: "Card task",
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision: 1,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    section_id: "sec-a",
    ...overrides,
  };
}

const project: ProjectDto = {
  id: "proj-1",
  name: "Board Project",
  color: "#3366ff",
  archived: false,
  favorite: false,
  sort_order: 0,
  view: "board",
  created_at: "2026-07-23T10:00:00Z",
  updated_at: "2026-07-23T10:00:00Z",
};

const sections: SectionDto[] = [
  {
    id: "sec-a",
    name: "Todo",
    project_id: "proj-1",
    collapsed: false,
    sort_order: 0,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
  },
  {
    id: "sec-b",
    name: "Doing",
    project_id: "proj-1",
    collapsed: false,
    sort_order: 1,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
  },
];

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
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("boardColumnOptions", () => {
  it("includes No Section plus every project section", () => {
    expect(boardColumnOptions(sections)).toEqual([
      { id: null, label: "No Section" },
      { id: "sec-a", label: "Todo" },
      { id: "sec-b", label: "Doing" },
    ]);
  });
});

describe("Board keyboard move menu (P2-FE-008)", () => {
  it("opens from the move control and commits a column choice with keyboard", async () => {
    const onMoveTask = vi.fn(async () => true);

    render(
      createElement(Board, {
        project,
        tasks: [makeTask()],
        sections,
        onMoveTask,
        onToggleTask: async () => true,
        onSelectTask: () => {},
        selectedTaskId: null,
      }),
    );

    const moveBtn = container.querySelector(
      'button[aria-label="Move task Card task"]',
    ) as HTMLButtonElement;
    expect(moveBtn).toBeTruthy();

    await act(async () => {
      moveBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    const menu = container.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.textContent).toContain("No Section");
    expect(menu?.textContent).toContain("Doing");
    expect(menu?.textContent).not.toContain("Todo");

    const doing = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Doing"),
    ) as HTMLButtonElement;
    expect(doing).toBeTruthy();

    await act(async () => {
      doing.click();
    });

    expect(onMoveTask).toHaveBeenCalledWith("task-1", "sec-b");
  });

  it("moves to No Section via the menu", async () => {
    const onMoveTask = vi.fn(async () => true);

    render(
      createElement(Board, {
        project,
        tasks: [makeTask()],
        sections,
        onMoveTask,
        onToggleTask: async () => true,
        onSelectTask: () => {},
        selectedTaskId: null,
      }),
    );

    const moveBtn = container.querySelector(
      'button[aria-label="Move task Card task"]',
    ) as HTMLButtonElement;

    await act(async () => {
      moveBtn.click();
    });

    const none = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("No Section"),
    ) as HTMLButtonElement;

    await act(async () => {
      none.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      none.click();
    });

    expect(onMoveTask).toHaveBeenCalledWith("task-1", null);
  });
});
