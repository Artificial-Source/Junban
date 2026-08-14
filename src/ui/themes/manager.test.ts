import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAppearance,
  applyThemeClass,
  getStoredTheme,
  initTheme,
  type ThemeId,
} from "./manager";

function mediaQuery(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    media: "(prefers-color-scheme: dark)",
    get matches() {
      return matches;
    },
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  return {
    query,
    change(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  for (const key of ["density", "fontSize", "fontFamily"]) {
    delete document.documentElement.dataset[key];
  }
});

afterEach(() => {
  applyThemeClass("light");
  vi.unstubAllGlobals();
});

describe("theme manager", () => {
  it("defaults to System and tracks prefers-color-scheme changes", () => {
    const media = mediaQuery(true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media.query),
    );

    expect(getStoredTheme()).toBe("system");
    expect(initTheme()).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    media.change(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    applyThemeClass("nord");
    expect(media.query.removeEventListener).toHaveBeenCalledOnce();
    media.change(true);
    expect(document.documentElement.classList.contains("nord")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("applies only the supplied confirmed appearance payload", () => {
    const theme: ThemeId = "dark";
    applyAppearance({
      theme,
      accent: "#3b82f6",
      density: "default",
      font_size: "medium",
      font_family: "inter",
      reduced_motion: true,
    });

    const root = document.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("reduce-motion")).toBe(true);
    expect(root.style.getPropertyValue("--color-accent")).toBe("#3b82f6");
    expect(root.dataset.density).toBe("default");
    expect(root.dataset.fontSize).toBe("medium");
    expect(root.dataset.fontFamily).toBe("inter");
    expect(localStorage.getItem("junban-theme")).toBe("dark");
  });
});
