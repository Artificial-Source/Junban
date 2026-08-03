/**
 * Wave 4a: lazy AI route shell renders the not-configured placeholder only.
 * @vitest-environment jsdom
 */
import { act, createElement, Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIChatRouteFallback } from "./AIChatRouteFallback";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushLazy() {
  // Resolve microtasks + lazy import boundary.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AIChatRoute shell", () => {
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

  it("renders the legacy not-configured shell in view mode", async () => {
    const onOpenSettings = vi.fn();
    const { AIChatRoute } = await import("./AIChatRoute");

    act(() => {
      root.render(createElement(AIChatRoute, { onOpenSettings }));
    });

    expect(container.textContent).toContain("AI Assistant");
    expect(container.textContent).toContain(
      "Configure an AI provider in Settings to start chatting.",
    );
    expect(container.querySelector('button[aria-label="Close AI chat"]')).toBeNull();

    const openSettings = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Open Settings"),
    );
    expect(openSettings).toBeTruthy();
    act(() => {
      openSettings?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("exposes a stable-dimension Suspense fallback", () => {
    act(() => {
      root.render(createElement(AIChatRouteFallback));
    });
    const status = container.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status?.getAttribute("aria-label")).toBe("Loading AI chat");
    expect(status?.className).toMatch(/h-full/);
    expect(status?.className).toMatch(/w-full/);
    expect(status?.className).toMatch(/min-h-/);
  });

  it("loads through React.lazy + Suspense without eager failure", async () => {
    const LazyRoute = (await import("react")).lazy(() =>
      import("./AIChatRoute").then((module) => ({ default: module.AIChatRoute })),
    );
    const onOpenSettings = vi.fn();

    act(() => {
      root.render(
        createElement(
          Suspense,
          { fallback: createElement(AIChatRouteFallback) },
          createElement(LazyRoute, { onOpenSettings }) as ReactNode,
        ),
      );
    });

    await flushLazy();
    expect(container.textContent).toContain("AI Assistant");
  });
});
