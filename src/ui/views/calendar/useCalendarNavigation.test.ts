/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useCalendarNavigation } from "./useCalendarNavigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function HookProbe({
  authoritativeMode,
  onSnapshot,
}: {
  authoritativeMode: "day" | "week" | "month" | null;
  onSnapshot: (mode: string) => void;
}) {
  const nav = useCalendarNavigation({ authoritativeMode, initialMode: "week" });
  onSnapshot(nav.mode);
  return createElement(
    "button",
    {
      type: "button",
      onClick: () => nav.setMode("month"),
    },
    "month",
  );
}

describe("useCalendarNavigation authoritative mode", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("syncs calendar_default once and keeps manual mode afterward", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let mode = "";
    const capture = (next: string) => {
      mode = next;
    };

    act(() => {
      root.render(createElement(HookProbe, { authoritativeMode: null, onSnapshot: capture }));
    });
    expect(mode).toBe("week");

    act(() => {
      root.render(createElement(HookProbe, { authoritativeMode: "day", onSnapshot: capture }));
    });
    expect(mode).toBe("day");

    act(() => {
      container.querySelector("button")?.click();
    });
    expect(mode).toBe("month");

    act(() => {
      root.render(createElement(HookProbe, { authoritativeMode: "week", onSnapshot: capture }));
    });
    // Manual mode wins after the user changes the segmented control.
    expect(mode).toBe("month");
  });
});
