/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSurfaceTexts, DeclarativeRenderer } from "./DeclarativeRenderer";
import { parsePluginSurface } from "./parsers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DeclarativeRenderer", () => {
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

  it("renders text as text and invokes fenced actions", async () => {
    const surface = parsePluginSurface({
      "surface-id": "panel",
      "root-index": 0,
      nodes: [
        {
          id: "root",
          "parent-index": null,
          content: { tag: "stack", val: { gap: 2, align: "start" } },
        },
        {
          id: "h",
          "parent-index": 0,
          content: {
            tag: "heading",
            val: { text: "Queued actions", tone: "neutral", size: "small" },
          },
        },
        {
          id: "t",
          "parent-index": 0,
          content: {
            tag: "text",
            val: { text: "3 tasks ready", tone: "neutral", size: "medium" },
          },
        },
        {
          id: "b",
          "parent-index": 0,
          content: {
            tag: "button",
            val: { label: "Run plan", "action-id": "run", tone: "accent", icon: null },
          },
        },
      ],
    });

    const onAction = vi.fn();
    act(() => {
      root.render(createElement(DeclarativeRenderer, { surface, onAction }));
    });

    expect(container.textContent).toContain("Queued actions");
    expect(container.textContent).toContain("3 tasks ready");
    expect(container.querySelector("script")).toBeNull();
    expect(collectSurfaceTexts(surface)).toEqual(
      expect.arrayContaining(["Queued actions", "3 tasks ready", "Run plan"]),
    );

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Run plan");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onAction).toHaveBeenCalledWith("run", []);
  });

  it("disables actions when fence is stale", async () => {
    const surface = parsePluginSurface({
      "surface-id": "s",
      "root-index": 0,
      nodes: [
        {
          id: "root",
          "parent-index": null,
          content: {
            tag: "button",
            val: { label: "Go", "action-id": "go", tone: "neutral", icon: null },
          },
        },
      ],
    });
    const onAction = vi.fn();
    act(() => {
      root.render(createElement(DeclarativeRenderer, { surface, onAction, disabled: true }));
    });
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onAction).not.toHaveBeenCalled();
  });
});
