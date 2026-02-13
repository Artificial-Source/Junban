import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginInstaller } from "../../src/plugins/installer.js";

function createTestPluginDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "docket-test-plugins-"));
}

describe("PluginInstaller", () => {
  let pluginDir: string;
  let tempDir: string;
  let installer: PluginInstaller;

  beforeEach(() => {
    pluginDir = createTestPluginDir();
    tempDir = createTestPluginDir();
    installer = new PluginInstaller(pluginDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Clean up best-effort
    }
  });

  describe("uninstall", () => {
    it("removes an installed plugin directory", async () => {
      const pluginPath = path.join(pluginDir, "test-plugin");
      fs.mkdirSync(pluginPath, { recursive: true });
      fs.writeFileSync(path.join(pluginPath, "manifest.json"), "{}");

      const result = await installer.uninstall("test-plugin");

      expect(result.success).toBe(true);
      expect(fs.existsSync(pluginPath)).toBe(false);
    });

    it("returns error for non-existent plugin", async () => {
      const result = await installer.uninstall("nonexistent");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });
  });
});
