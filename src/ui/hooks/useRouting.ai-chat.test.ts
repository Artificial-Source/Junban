/**
 * Wave 4a: direct-load and back/forward ownership for the canonical /ai-chat route.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "./test-utils";
import { useRouting } from "./useRouting";

describe("useRouting ai-chat navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("direct-loads /ai-chat as the content route", () => {
    window.history.replaceState(null, "", "/ai-chat");
    const { result } = renderHook(() => useRouting());
    expect(result.current.route).toEqual({ name: "ai-chat" });
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.settingsOpen).toBe(false);
  });

  it("navigates to /ai-chat and restores the prior route on popstate", () => {
    window.history.replaceState(null, "", "/inbox");
    const { result } = renderHook(() => useRouting());
    expect(result.current.route).toEqual({ name: "inbox" });

    act(() => {
      result.current.navigate("ai-chat");
    });
    expect(result.current.route).toEqual({ name: "ai-chat" });
    expect(window.location.pathname).toBe("/ai-chat");

    act(() => {
      window.history.pushState(null, "", "/inbox");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.route).toEqual({ name: "inbox" });
    expect(result.current.view).toBe("inbox");
  });

  it("forward navigation can return to /ai-chat via popstate", () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useRouting());

    act(() => {
      result.current.navigate("ai-chat");
    });
    expect(result.current.view).toBe("ai-chat");

    act(() => {
      window.history.pushState(null, "", "/today");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.view).toBe("today");

    act(() => {
      window.history.pushState(null, "", "/ai-chat");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.route).toEqual({ name: "ai-chat" });
    expect(result.current.view).toBe("ai-chat");
  });
});
