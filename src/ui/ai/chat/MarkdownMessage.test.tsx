/**
 * Safe Markdown XSS / unsafe URL coverage.
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownMessage safety", () => {
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

  it("skips raw HTML and blocks javascript: URLs", () => {
    act(() => {
      root.render(
        createElement(MarkdownMessage, {
          content:
            "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[ok](https://example.com)",
        }),
      );
    });

    expect(container.querySelector("script")).toBeNull();
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.some((a) => (a.getAttribute("href") ?? "").startsWith("javascript:"))).toBe(
      false,
    );
    const safe = anchors.find((a) => a.getAttribute("href") === "https://example.com");
    expect(safe).toBeTruthy();
    expect(safe?.getAttribute("rel")).toContain("noopener");
    expect(safe?.getAttribute("rel")).toContain("noreferrer");
    expect(safe?.getAttribute("target")).toBe("_blank");
  });

  it("blocks data: URLs", () => {
    act(() => {
      root.render(
        createElement(MarkdownMessage, {
          content: "[bad](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
        }),
      );
    });
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.every((a) => !(a.getAttribute("href") ?? "").startsWith("data:"))).toBe(true);
  });
});
