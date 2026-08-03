/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceButton } from "./VoiceButton";
import { MICROPHONE_PERMISSION_GUIDANCE } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("VoiceButton", () => {
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

  it("renders accessible idle/listening/transcribing states", () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(createElement(VoiceButton, { onToggle, state: "idle" }));
    });
    const btn = container.querySelector('[data-testid="voice-button"]') as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("Start voice input");
    expect(btn.getAttribute("data-state")).toBe("idle");

    act(() => {
      root.render(createElement(VoiceButton, { onToggle, state: "listening" }));
    });
    expect(btn.getAttribute("aria-label")).toBe("Stop voice input");
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      root.render(createElement(VoiceButton, { onToggle, state: "transcribing" }));
    });
    expect(container.querySelector('[data-testid="voice-button"]')?.getAttribute("aria-busy")).toBe(
      "true",
    );
  });

  it("shows permission alert live region without side effects", () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        createElement(VoiceButton, {
          onToggle,
          state: "error",
          permissionError: MICROPHONE_PERMISSION_GUIDANCE,
        }),
      );
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Microphone access was denied");
    expect(container.textContent).toContain("Retry microphone access");
    expect(onToggle).not.toHaveBeenCalled();
  });
});
