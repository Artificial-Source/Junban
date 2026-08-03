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

  it("keeps accessible alert + retry for arbitrary normal ?ptt-error query", () => {
    const previous = window.location.href;
    // Simulate a normal product URL that happens to include ptt-error — must not
    // hide the permission alert or leave aria-describedby dangling.
    window.history.replaceState({}, "", "/ai-chat?ptt-error");
    try {
      const onToggle = vi.fn();
      const onRetry = vi.fn();
      act(() => {
        root.render(
          createElement(VoiceButton, {
            onToggle,
            onRetry,
            state: "error",
            permissionError: MICROPHONE_PERMISSION_GUIDANCE,
          }),
        );
      });

      const btn = container.querySelector('[data-testid="voice-button"]') as HTMLButtonElement;
      const alert = container.querySelector('[role="alert"]') as HTMLElement;
      expect(alert).not.toBeNull();
      expect(alert.textContent).toContain("Microphone access was denied");
      expect(container.textContent).toContain("Retry microphone access");

      const describedBy = btn.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(alert.id).toBe(describedBy);
      expect(document.getElementById(describedBy!)).toBe(alert);

      const retry = container.querySelector('button:not([data-testid="voice-button"])');
      expect(retry).not.toBeNull();
      act(() => {
        (retry as HTMLButtonElement).click();
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onToggle).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState({}, "", previous);
    }
  });
});
