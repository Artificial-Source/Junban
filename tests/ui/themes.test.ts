import { describe, it, expect } from "vitest";
import { BUILT_IN_THEMES } from "../../src/config/themes.js";

describe("BUILT_IN_THEMES", () => {
  it("includes light and dark", () => {
    const ids = BUILT_IN_THEMES.map((t) => t.id);
    expect(ids).toContain("light");
    expect(ids).toContain("dark");
  });

  it("light theme has type light", () => {
    const light = BUILT_IN_THEMES.find((t) => t.id === "light");
    expect(light?.type).toBe("light");
  });

  it("dark theme has type dark", () => {
    const dark = BUILT_IN_THEMES.find((t) => t.id === "dark");
    expect(dark?.type).toBe("dark");
  });

  it("has exactly 2 built-in themes", () => {
    expect(BUILT_IN_THEMES).toHaveLength(2);
  });

  it("all themes have required fields", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.id).toBeTruthy();
      expect(theme.name).toBeTruthy();
      expect(["light", "dark"]).toContain(theme.type);
    }
  });
});
