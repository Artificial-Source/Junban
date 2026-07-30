/**
 * P2-A11Y-002: keyboard reorder path on the task handle (Alt+ArrowUp/Down).
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "../api/client";
import { TaskList } from "./TaskList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTask(id: string, title: string): TaskDto {
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
  };
}

const tasks = [makeTask("t1", "Alpha"), makeTask("t2", "Bravo"), makeTask("t3", "Charlie")];

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

function handleFor(title: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((el) =>
    el.getAttribute("aria-label")?.startsWith(`Reorder task: ${title}`),
  );
  expect(btn).toBeTruthy();
  return btn as HTMLButtonElement;
}

describe("TaskList keyboard reorder (P2-A11Y-002)", () => {
  it("moves a middle task up and down via Alt+Arrow keys", async () => {
    const onReorder = vi.fn(async () => true);
    render(
      createElement(TaskList, {
        tasks,
        onToggle: async () => true,
        onSelect: () => {},
        selectedTaskId: null,
        emptyMessage: "empty",
        todayKey: "2026-07-23",
        onReorder,
      }),
    );

    const handle = handleFor("Bravo");
    expect(handle.getAttribute("aria-label")).not.toBe("Drag");
    expect(handle.getAttribute("aria-label")).toMatch(/Alt\+ArrowUp/);

    await act(async () => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }),
      );
    });
    expect(onReorder).toHaveBeenCalledWith(["t2", "t1", "t3"]);

    onReorder.mockClear();
    await act(async () => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
      );
    });
    expect(onReorder).toHaveBeenCalledWith(["t1", "t3", "t2"]);
  });

  it("is a no-op at the first and last boundaries", async () => {
    const onReorder = vi.fn(async () => true);
    render(
      createElement(TaskList, {
        tasks,
        onToggle: async () => true,
        onSelect: () => {},
        selectedTaskId: null,
        emptyMessage: "empty",
        todayKey: "2026-07-23",
        onReorder,
      }),
    );

    await act(async () => {
      handleFor("Alpha").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }),
      );
    });
    expect(onReorder).not.toHaveBeenCalled();

    await act(async () => {
      handleFor("Charlie").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
      );
    });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
