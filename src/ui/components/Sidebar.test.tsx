import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResponse } from "../api/client";
import type { AppRoute, NavigateTarget, View } from "../hooks/useRouting";
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

  function render(options?: {
    phase2VisualFixture?: boolean;
    currentView?: View;
    currentRoute?: AppRoute;
    onNavigate?: (target: NavigateTarget) => void;
    collapsed?: boolean;
  }) {
    act(() => {
      root.render(
        createElement(Sidebar, {
          currentView: options?.currentView ?? "today",
          currentRoute: options?.currentRoute ?? { name: "today" },
          onNavigate: options?.onNavigate ?? (() => {}),
          onAddTask: () => {},
          onSearch: () => {},
          collapsed: options?.collapsed ?? false,
          onToggleCollapsed: () => {},
          catalog,
          onOpenProjectModal: () => {},
          phase2VisualFixture: options?.phase2VisualFixture ?? false,
        }),
      );
    });
  }

  it("uses Phase 2 chrome only when the explicit fixture prop is enabled", () => {
    render({ phase2VisualFixture: false });
    expect(container.textContent).toContain("Calendar");
    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).not.toContain("Filters & Labels");

    render({ phase2VisualFixture: true });
    expect(container.textContent).toContain("Filters & Labels");
    expect(container.textContent).not.toContain("Calendar");
    expect(container.textContent).not.toContain("Workspace");
  });

  it("keeps AI Chat live in Workspace and navigates to ai-chat", () => {
    const onNavigate = vi.fn();
    render({ onNavigate });

    const aiButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("AI Chat"),
    );
    expect(aiButton).toBeTruthy();
    expect(aiButton?.getAttribute("aria-disabled")).toBeNull();
    expect(aiButton?.getAttribute("aria-current")).toBeNull();

    act(() => {
      aiButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith("ai-chat");
  });

  it("marks AI Chat as the current page on the ai-chat route", () => {
    render({
      currentView: "ai-chat",
      currentRoute: { name: "ai-chat" },
    });

    const aiButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("AI Chat"),
    );
    expect(aiButton?.getAttribute("aria-current")).toBe("page");
    expect(aiButton?.className).toMatch(/bg-accent-action\/10/);
  });
});
