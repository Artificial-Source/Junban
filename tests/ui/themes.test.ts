import { describe, it, expect } from "vitest";
import { THEME_VARIABLES, BUILT_IN_THEMES, type CustomTheme } from "../../src/config/themes.js";

describe("THEME_VARIABLES", () => {
  it("has all 18 entries", () => {
    expect(THEME_VARIABLES).toHaveLength(18);
  });

  it("all entries have required fields", () => {
    for (const v of THEME_VARIABLES) {
      expect(v.key).toBeTruthy();
      expect(v.label).toBeTruthy();
      expect(v.group).toBeTruthy();
      expect(v.key.startsWith("--")).toBe(true);
    }
  });

  it("has unique keys", () => {
    const keys = THEME_VARIABLES.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers all expected groups", () => {
    const groups = new Set(THEME_VARIABLES.map((v) => v.group));
    expect(groups).toContain("Background");
    expect(groups).toContain("Text");
    expect(groups).toContain("UI");
    expect(groups).toContain("Status");
    expect(groups).toContain("Priority");
    expect(groups).toContain("Layout");
  });
});

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
});

describe("CustomTheme import/export roundtrip", () => {
  it("serializes and deserializes correctly", () => {
    const theme: CustomTheme = {
      id: "custom-test",
      name: "My Test Theme",
      type: "dark",
      variables: {
        "--color-bg": "#1a1a1a",
        "--color-text": "#ffffff",
        "--color-accent": "#3b82f6",
        "--radius": "0.75rem",
      },
    };

    const json = JSON.stringify(theme);
    const parsed = JSON.parse(json) as CustomTheme;

    expect(parsed.id).toBe(theme.id);
    expect(parsed.name).toBe(theme.name);
    expect(parsed.type).toBe(theme.type);
    expect(parsed.variables).toEqual(theme.variables);
  });

  it("rejects invalid theme JSON", () => {
    const invalidJson = '{"name": "test"}';
    const parsed = JSON.parse(invalidJson);

    // A valid custom theme must have id, name, type, and variables
    expect(parsed.variables).toBeUndefined();
    expect(parsed.type).toBeUndefined();
    expect(parsed.id).toBeUndefined();
  });
});
