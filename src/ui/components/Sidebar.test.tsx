import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogResponse } from "../api/client";
import { Sidebar } from "./Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalog: CatalogResponse = {
  projects: [],
  sections: [],
  tags: [],
  templates: [],
  saved_filters: [],
  revision: 1,
};

describe("Sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(phase2VisualFixture: boolean) {
    act(() => {
      root.render(
        createElement(Sidebar, {
          currentView: "today",
          currentRoute: { name: "today" },
          onNavigate: () => {},
          onAddTask: () => {},
          onSearch: () => {},
          collapsed: false,
          onToggleCollapsed: () => {},
          catalog,
          onOpenProjectModal: () => {},
          phase2VisualFixture,
        }),
      );
    });
  }

  it("uses Phase 2 chrome only when the explicit fixture prop is enabled", () => {
    render(false);
    expect(container.textContent).toContain("Calendar");
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).not.toContain("Filters & Labels");

    render(true);
    expect(container.textContent).toContain("Filters & Labels");
    expect(container.textContent).not.toContain("Calendar");
    expect(container.textContent).not.toContain("Workspace");
  });
});
