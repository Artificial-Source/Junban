/**
 * P2-A11Y-006: SearchModal combobox accessible name.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchModal } from "./SearchModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
}));

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({ catalog: { projects: [], tags: [], sections: [], templates: [] } }),
}));

vi.mock("../api/client", () => ({
  listTasks: vi.fn(async () => ({ tasks: [], revision: 1 })),
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

describe("SearchModal accessibility (P2-A11Y-006)", () => {
  it("exposes a labelled combobox", () => {
    render(
      createElement(SearchModal, {
        isOpen: true,
        onClose: () => {},
        onSelectTask: () => {},
      }),
    );

    const combobox = container.querySelector('[role="combobox"]') as HTMLInputElement;
    expect(combobox).toBeTruthy();
    expect(combobox.getAttribute("aria-label")).toBe("Search tasks");
    expect(combobox.getAttribute("aria-controls")).toBe("search-results-list");
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
  });
});
