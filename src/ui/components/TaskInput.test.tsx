/**
 * TaskInput error recovery after timed-out / failed create (ISSUE-006).
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../api/client";
import { TaskInput } from "./TaskInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(el: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactElement) {
  act(() => {
    root.render(ui);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("TaskInput recovery", () => {
  it("keeps the draft editable and exposes Retry after a network timeout", async () => {
    const onParseAndCreate = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("Request timed out", true, false))
      .mockResolvedValueOnce(true);

    render(createElement(TaskInput, { onParseAndCreate }));

    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "Dogfood priority today p2");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onParseAndCreate).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Request timed out");
    expect((container.querySelector("input") as HTMLInputElement).disabled).toBe(false);
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(
      "Dogfood priority today p2",
    );
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBeNull();

    const retry = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Retry"),
    ) as HTMLButtonElement;
    expect(retry).toBeTruthy();

    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(onParseAndCreate).toHaveBeenCalledTimes(2);
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});
