/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiOnboarding } from "./AiOnboarding";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AiOnboarding", () => {
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

  it("exposes Configure AI / Set up voice / Not now actions", () => {
    const onConfigureAi = vi.fn();
    const onSetupVoice = vi.fn();
    const onDismiss = vi.fn();

    act(() => {
      root.render(createElement(AiOnboarding, { onConfigureAi, onSetupVoice, onDismiss }));
    });

    expect(container.textContent).toContain("Meet your AI assistant");
    const buttons = Array.from(container.querySelectorAll("button"));
    const configure = buttons.find((b) => b.textContent?.includes("Configure AI"));
    const voice = buttons.find((b) => b.textContent?.includes("Set up voice"));
    const notNow = buttons.find((b) => b.textContent?.includes("Not now"));
    expect(configure && voice && notNow).toBeTruthy();

    act(() => configure?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => voice?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => notNow?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onConfigureAi).toHaveBeenCalledTimes(1);
    expect(onSetupVoice).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
