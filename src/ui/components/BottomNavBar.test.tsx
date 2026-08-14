/**
 * Wave 4a: mobile center AI control navigates to the canonical ai-chat route.
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomNavBar } from "./BottomNavBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BottomNavBar AI action", () => {
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

  it("renders a live center AI control that navigates to ai-chat", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(
        createElement(BottomNavBar, {
          currentView: "today",
          onNavigate,
          onMenuOpen: () => {},
        }),
      );
    });

    const aiButton = container.querySelector('button[aria-label="AI Assistant"]');
    expect(aiButton).toBeTruthy();
    expect(aiButton?.getAttribute("aria-current")).toBeNull();

    act(() => {
      aiButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith("ai-chat");
  });

  it("marks the AI control current on the ai-chat view", () => {
    act(() => {
      root.render(
        createElement(BottomNavBar, {
          currentView: "ai-chat",
          onNavigate: () => {},
          onMenuOpen: () => {},
        }),
      );
    });

    const aiButton = container.querySelector('button[aria-label="AI Assistant"]');
    expect(aiButton?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps a minimum 44px touch target on the AI control", () => {
    act(() => {
      root.render(
        createElement(BottomNavBar, {
          currentView: "inbox",
          onNavigate: () => {},
          onMenuOpen: () => {},
        }),
      );
    });

    const aiButton = container.querySelector('button[aria-label="AI Assistant"]');
    expect(aiButton?.className).toMatch(/w-12/);
    expect(aiButton?.className).toMatch(/h-12/);
  });
});
