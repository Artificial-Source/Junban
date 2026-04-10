import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIRECT_PLUGIN_POLICIES } from "../../../src/ui/api/plugins.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readBuiltInManifests(): Record<string, { permissions: string[]; settings: unknown[] }> {
  const manifestsDir = path.resolve(__dirname, "../../../src/plugins/builtin");
  const pluginDirs = fs
    .readdirSync(manifestsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const manifests: Record<string, { permissions: string[]; settings: unknown[] }> = {};
  for (const pluginDir of pluginDirs) {
    const manifestPath = path.join(manifestsDir, pluginDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      id: string;
      permissions: string[];
      settings: unknown[];
    };
    manifests[manifest.id] = {
      permissions: manifest.permissions,
      settings: manifest.settings,
    };
  }

  return manifests;
}

describe("DIRECT_PLUGIN_POLICIES", () => {
  it("exactly matches built-in plugin manifests", () => {
    const manifests = readBuiltInManifests();
    expect(DIRECT_PLUGIN_POLICIES).toEqual(manifests);
    expect(Object.keys(DIRECT_PLUGIN_POLICIES).sort()).toEqual(Object.keys(manifests).sort());
  });
});
