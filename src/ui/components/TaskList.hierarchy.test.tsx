/**
 * P2-FE-008: hierarchy depth rendering and indent/outdent wiring through TaskList.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "../api/client";
import { TaskList } from "./TaskList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTask(id: string, title: string, parent_id: string | null = null): TaskDto {
  return {
    id,
    title,
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision: 1,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    parent_id,
  };
}

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

describe("TaskList hierarchy (P2-FE-008)", () => {
  it("renders nested depth from the parent graph rather than hard-coding depth 1", () => {
    const tasks = [
      makeTask("a", "Root"),
      makeTask("b", "Child", "a"),
      makeTask("c", "Grandchild", "b"),
    ];

    render(
      createElement(TaskList, {
        tasks,
        onToggle: async () => true,
        onSelect: () => {},
        selectedTaskId: null,
        emptyMessage: "empty",
        todayKey: "2026-07-23",
        onIndent: async () => true,
        onOutdent: async () => true,
      }),
    );

    const rows = Array.from(container.querySelectorAll("[data-task-id]")).map((el) => {
      const row = el.closest(".group") as HTMLElement;
      return {
        id: el.getAttribute("data-task-id"),
        paddingLeft: row?.style.paddingLeft,
      };
    });

    expect(rows).toEqual([
      { id: "a", paddingLeft: "0.75rem" },
      { id: "b", paddingLeft: "2.25rem" },
      { id: "c", paddingLeft: "3.75rem" },
    ]);
  });

  it("wires indent/outdent keyboard actions on the drag handle", async () => {
    const onIndent = vi.fn(async () => true);
    const onOutdent = vi.fn(async () => true);
    const tasks = [makeTask("a", "Alpha"), makeTask("b", "Bravo"), makeTask("c", "Charlie", "b")];

    render(
      createElement(TaskList, {
        tasks,
        onToggle: async () => true,
        onSelect: () => {},
        selectedTaskId: null,
        emptyMessage: "empty",
        todayKey: "2026-07-23",
        onIndent,
        onOutdent,
      }),
    );

    const bravoHandle = container.querySelector(
      'button[aria-label="Task handle: Bravo"]',
    ) as HTMLButtonElement;
    await act(async () => {
      bravoHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onIndent).toHaveBeenCalledWith("b");

    const charlieHandle = container.querySelector(
      'button[aria-label="Task handle: Charlie"]',
    ) as HTMLButtonElement;
    await act(async () => {
      charlieHandle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(onOutdent).toHaveBeenCalledWith("c");
  });
});
