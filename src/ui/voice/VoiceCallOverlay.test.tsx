/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallOverlay } from "./VoiceCallOverlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("VoiceCallOverlay", () => {
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

  it("renders listening/thinking/speaking/grace/error states", () => {
    const onEnd = vi.fn();
    act(() => {
      root.render(
        createElement(VoiceCallOverlay, {
          callState: "listening",
          callDuration: 12,
          onEndCall: onEnd,
        }),
      );
    });
    expect(container.querySelector('[data-testid="call-state-label"]')?.textContent).toBe(
      "Listening...",
    );
    expect(container.querySelector('[data-testid="call-duration"]')?.textContent).toBe("0:12");

    act(() => {
      root.render(
        createElement(VoiceCallOverlay, {
          callState: "processing",
          callDuration: 18,
          onEndCall: onEnd,
        }),
      );
    });
    expect(container.querySelector('[data-testid="call-state-label"]')?.textContent).toBe(
      "Thinking...",
    );

    act(() => {
      root.render(
        createElement(VoiceCallOverlay, {
          callState: "speaking",
          callDuration: 75,
          onEndCall: onEnd,
          isInGracePeriod: true,
          gracePeriodProgress: 0.55,
        }),
      );
    });
    expect(container.querySelector('[data-testid="call-state-label"]')?.textContent).toBe(
      "Waiting...",
    );
    expect(container.querySelector('[role="progressbar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="call-duration"]')?.textContent).toBe("1:15");

    act(() => {
      root.render(
        createElement(VoiceCallOverlay, {
          callState: "listening",
          callDuration: 33,
          onEndCall: onEnd,
          recognitionError: "Microphone access was denied. Allow microphone access, then retry.",
          onRetryRecognition: vi.fn(),
        }),
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Microphone access was denied",
    );

    const end = container.querySelector('[data-testid="end-call-button"]') as HTMLButtonElement;
    act(() => end.click());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
