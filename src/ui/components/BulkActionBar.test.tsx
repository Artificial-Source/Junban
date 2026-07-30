/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkActionBar } from "./BulkActionBar";
import type { TagDto } from "../api/client";

function tag(id: string, name: string): TagDto {
  return {
    id,
    name,
    color: "#8a2be2",
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
  };
}

describe("BulkActionBar tag picker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it("sends the selected catalog tag UUID, never free text", async () => {
    const onAddTag = vi.fn(async () => true);

    await act(async () => {
      root.render(
        createElement(BulkActionBar, {
          selectedCount: 2,
          onComplete: async () => true,
          onDelete: async () => true,
          onMoveToProject: async () => true,
          onAddTag,
          onClear: () => undefined,
          projects: [],
          tags: [tag("11111111-1111-4111-8111-111111111111", "infra")],
        }),
      );
    });

    const open = container.querySelector('[aria-label="Add tag to selected tasks"]');
    expect(open).toBeTruthy();
    await act(async () => {
      (open as HTMLButtonElement).click();
    });

    const option = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("infra"),
    );
    expect(option).toBeTruthy();
    await act(async () => {
      (option as HTMLButtonElement).click();
    });

    expect(onAddTag).toHaveBeenCalledTimes(1);
    expect(onAddTag).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(container.querySelector('input[placeholder="Tag name"]')).toBeNull();
  });

  it("exposes menu trigger semantics and keyboard navigation (P2-A11Y-007)", async () => {
    const onMoveToProject = vi.fn(async () => true);
    const projects = [
      {
        id: "proj-1",
        name: "Website",
        color: "#3366ff",
        archived: false,
        favorite: false,
        sort_order: 0,
        view: "list" as const,
        created_at: "2026-07-28T00:00:00Z",
        updated_at: "2026-07-28T00:00:00Z",
      },
    ];

    await act(async () => {
      root.render(
        createElement(BulkActionBar, {
          selectedCount: 1,
          onComplete: async () => true,
          onDelete: async () => true,
          onMoveToProject,
          onAddTag: async () => true,
          onClear: () => undefined,
          projects,
          tags: [],
        }),
      );
    });

    const trigger = container.querySelector(
      '[aria-label="Move selected tasks"]',
    ) as HTMLButtonElement;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });

    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBeTruthy();

    // Initial focus lands on the first menuitem.
    const items = Array.from(
      container.querySelectorAll('[role="menuitem"]'),
    ) as HTMLButtonElement[];
    expect(items.length).toBe(2);
    expect(document.activeElement).toBe(items[0]);

    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);

    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(items[0]);

    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);

    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onMoveToProject).toHaveBeenCalledWith("proj-1");

    // Re-open and Escape restores trigger focus.
    await act(async () => {
      trigger.click();
    });
    expect(container.querySelector('[role="menu"]')).toBeTruthy();

    await act(async () => {
      container
        .querySelector('[role="menu"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
    });

    // rAF restores focus to the trigger.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
