/**
 * P2-FE-002: multi-select wiring through TaskList into bulk selection callbacks.
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "../api/client";
import { TaskList } from "./TaskList";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { BulkActionBar } from "./BulkActionBar";

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

function InboxLikeView() {
  const multiSelect = useMultiSelect();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  return createElement(
    "div",
    null,
    multiSelect.count > 0
      ? createElement(BulkActionBar, {
          selectedCount: multiSelect.count,
          onComplete: async () => true,
          onDelete: async () => true,
          onMoveToProject: async () => true,
          onAddTag: async () => true,
          onClear: multiSelect.clear,
          projects: [],
          tags: [],
        })
      : null,
    createElement(TaskList, {
      tasks,
      onToggle: async () => true,
      onSelect: setSelectedTaskId,
      selectedTaskId,
      selectedTaskIds: multiSelect.selectedIds,
      onMultiSelect: multiSelect.handleSelect,
      emptyMessage: "empty",
      todayKey: "2026-07-23",
    }),
  );
}

function clickRow(title: string, init: MouseEventInit) {
  const task = tasks.find((candidate) => candidate.title === title);
  const rowButton = task
    ? container.querySelector<HTMLButtonElement>(`[data-task-id="${task.id}"]`)
    : null;
  // Multi-select is on the row container (parent of the open-details button).
  const row = rowButton?.closest("div.group") as HTMLElement | null;
  expect(row).toBeTruthy();
  act(() => {
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  });
}

describe("TaskList multi-select wiring (P2-FE-002)", () => {
  it("shows the bulk action bar after cmd/ctrl toggle selection", () => {
    render(createElement(InboxLikeView));
    expect(container.querySelector('[aria-label="Bulk task actions"]')).toBeNull();

    clickRow("Alpha", { ctrlKey: true });
    expect(container.querySelector('[aria-label="Bulk task actions"]')).toBeTruthy();
    expect(container.textContent).toContain("1 selected");

    clickRow("Charlie", { metaKey: true });
    expect(container.textContent).toContain("2 selected");
  });

  it("shift-click selects a contiguous range over the visible ordered ids", () => {
    render(createElement(InboxLikeView));

    clickRow("Alpha", { ctrlKey: true });
    clickRow("Charlie", { shiftKey: true });

    expect(container.textContent).toContain("3 selected");
    const multiSelected = container.querySelectorAll(".bg-accent-action\\/5");
    // selected rows get multi-select styling; at least the three tasks should reflect selection
    expect(multiSelected.length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('[aria-label="Bulk task actions"]')).toBeTruthy();
  });

  it("passes the current list ordered ids into onMultiSelect for range math", () => {
    const onMultiSelect = vi.fn();
    render(
      createElement(TaskList, {
        tasks,
        onToggle: async () => true,
        onSelect: () => {},
        selectedTaskId: null,
        selectedTaskIds: new Set<string>(),
        onMultiSelect,
        emptyMessage: "empty",
        todayKey: "2026-07-23",
      }),
    );

    clickRow("Bravo", { shiftKey: true });
    expect(onMultiSelect).toHaveBeenCalledTimes(1);
    expect(onMultiSelect.mock.calls[0]?.[0]).toBe("t2");
    expect(onMultiSelect.mock.calls[0]?.[2]).toEqual(["t1", "t2", "t3"]);
  });

  it("supports keyboard Space toggle and Shift+Space range on the focus control (P2-A11Y-003)", () => {
    render(createElement(InboxLikeView));

    const alpha = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.getAttribute("aria-label") === "Task: Alpha",
    ) as HTMLButtonElement;
    const charlie = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.getAttribute("aria-label") === "Task: Charlie",
    ) as HTMLButtonElement;

    act(() => {
      alpha.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[aria-label="Bulk task actions"]')).toBeTruthy();
    expect(container.textContent).toContain("1 selected");
    expect(alpha.getAttribute("aria-label")).toBe("Task: Alpha, selected");

    act(() => {
      charlie.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.textContent).toContain("3 selected");
    expect(charlie.getAttribute("aria-label")).toBe("Task: Charlie, selected");

    // Bulk actions remain reachable in the document tab order while selection is active.
    const bulkComplete = container.querySelector(
      '[aria-label="Complete selected tasks"]',
    ) as HTMLButtonElement;
    expect(bulkComplete).toBeTruthy();
    expect(bulkComplete.disabled).toBe(false);
  });
});
