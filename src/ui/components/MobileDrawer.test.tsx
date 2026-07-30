/**
 * P2-A11Y-001: MobileDrawer focus trap, Escape, restoration, inert background.
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileDrawer } from "./MobileDrawer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function DrawerHarness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return createElement(
    "div",
    { "data-app-root": "true" },
    createElement(
      "main",
      null,
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "Open navigation menu",
          onClick: () => setOpen(true),
        },
        "Menu",
      ),
      createElement("button", { type: "button" }, "Background action"),
    ),
    createElement(
      MobileDrawer,
      { open, onClose: () => setOpen(false), id: "test-drawer" },
      createElement(
        "nav",
        { "aria-label": "Drawer nav" },
        createElement("button", { type: "button" }, "Inbox"),
        createElement("button", { type: "button" }, "Today"),
      ),
    ),
  );
}

describe("MobileDrawer accessibility (P2-A11Y-001)", () => {
  it("traps focus, closes on Escape, restores opener, and inerts siblings", async () => {
    render(createElement(DrawerHarness));

    const opener = container.querySelector(
      '[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await act(async () => {
      opener.click();
    });

    const dialog = container.querySelector(
      '[role="dialog"][aria-label="Navigation drawer"]',
    ) as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    // Initial focus moves into the drawer.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Background siblings are inert while open.
    const main = container.querySelector("main") as HTMLElement;
    expect(main.inert).toBe(true);

    // Tab cycles within the drawer.
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    focusables[0]!.focus();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    // After Tab from last would wrap; from first, browser would move — trap only
    // intervenes at ends. Jump to last and Shift+Tab to prove wrap.
    focusables[focusables.length - 1]!.focus();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(focusables[0]);

    focusables[0]!.focus();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);

    // Escape dismisses and restores the opener.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(main.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("invokes onClose from the backdrop", async () => {
    const onClose = vi.fn();
    render(
      createElement(
        MobileDrawer,
        { open: true, onClose },
        createElement("button", { type: "button" }, "Item"),
      ),
    );

    const backdrop = container.querySelector(".bg-black\\/50") as HTMLElement;
    await act(async () => {
      backdrop.click();
    });
    expect(onClose).toHaveBeenCalled();
  });
});
