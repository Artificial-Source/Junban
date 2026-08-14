/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Settings Extensions lazy boundary", () => {
  it("SettingsDialog lazy-imports PluginsTab", () => {
    const source = readFileSync(
      join(process.cwd(), "src/ui/views/settings/SettingsDialog.tsx"),
      "utf8",
    );
    expect(source).toMatch(/lazy\(\(\)\s*=>\s*\n?\s*import\("\.\.\/\.\.\/plugins\/PluginsTab"\)/);
    expect(source).toContain('case "plugins"');
  });

  it("settings helpers register Extensions tab id plugins", () => {
    const source = readFileSync(
      join(process.cwd(), "src/ui/views/settings/settingsHelpers.ts"),
      "utf8",
    );
    expect(source).toContain('id: "plugins"');
    expect(source).toContain('label: "Extensions"');
  });

  it("routing allows plugins settings tab and namespaced plugin views", () => {
    const source = readFileSync(join(process.cwd(), "src/ui/hooks/useRouting.ts"), "utf8");
    expect(source).toContain('"plugins"');
    expect(source).toContain("plugin-view");
    expect(source).toContain(
      "`/ext/${encodeURIComponent(route.pluginId)}/${encodeURIComponent(route.surfaceId)}`",
    );
  });
});
