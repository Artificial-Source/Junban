/**
 * P2-A11Y-004: AddProjectModal Escape closes while not submitting.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddProjectModal } from "./AddProjectModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
}));

vi.mock("../hooks/useCatalogMutations", () => ({
  useCatalogMutations: () => ({
    createProject: vi.fn(async () => null),
  }),
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

describe("AddProjectModal Escape (P2-A11Y-004)", () => {
  it("closes on Escape when not submitting", async () => {
    const onClose = vi.fn();
    render(createElement(AddProjectModal, { open: true, onClose }));

    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(createElement(AddProjectModal, { open: false, onClose: () => {} }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
