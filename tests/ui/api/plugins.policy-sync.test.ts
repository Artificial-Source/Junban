import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIRECT_PLUGIN_POLICIES } from "../../../src/ui/api/plugins.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readManifest(relativePath: string) {
  const filePath = path.resolve(__dirname, "../../..", relativePath);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    permissions: string[];
    settings: unknown[];
  };
}

describe("DIRECT_PLUGIN_POLICIES", () => {
  it("matches the built-in pomodoro manifest", () => {
    const manifest = readManifest("src/plugins/builtin/pomodoro/manifest.json");
    expect(DIRECT_PLUGIN_POLICIES.pomodoro).toEqual({
      permissions: manifest.permissions,
      settings: manifest.settings,
    });
  });

  it("matches the built-in timeblocking manifest", () => {
    const manifest = readManifest("src/plugins/builtin/timeblocking/manifest.json");
    expect(DIRECT_PLUGIN_POLICIES.timeblocking).toEqual({
      permissions: manifest.permissions,
      settings: manifest.settings,
    });
  });
});
