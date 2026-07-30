/**
 * P2-A11Y-006: combobox labelling and option surface without nested buttons.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
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
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("CommandPalette accessibility (P2-A11Y-006)", () => {
  it("labels the combobox and keeps options as a single interactive surface", async () => {
    const goToday = vi.fn();
    render(
      createElement(CommandPalette, {
        isOpen: true,
        onClose: () => {},
        commands: [
          { id: "today", name: "Go to Today", callback: goToday, hotkey: "G T" },
          { id: "inbox", name: "Go to Inbox", callback: () => {} },
        ],
      }),
    );

    const combobox = container.querySelector('[role="combobox"]') as HTMLInputElement;
    expect(combobox).toBeTruthy();
    expect(combobox.getAttribute("aria-label")).toBe("Filter commands");
    expect(combobox.getAttribute("aria-controls")).toBe("command-palette-list");
    expect(combobox.getAttribute("aria-activedescendant")).toBe("cmd-today");

    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    for (const option of options) {
      expect(option.querySelector("button")).toBeNull();
    }

    await act(async () => {
      (options[0] as HTMLElement).click();
    });
    expect(goToday).toHaveBeenCalled();
  });
});
