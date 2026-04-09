import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { PluginInstaller } from "../../src/plugins/installer.js";

function createTestPluginDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "junban-test-plugins-"));
}

describe("PluginInstaller", () => {
  let pluginDir: string;
  let tempDir: string;
  let installer: PluginInstaller;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    pluginDir = createTestPluginDir();
    tempDir = createTestPluginDir();
    installer = new PluginInstaller(pluginDir);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Clean up best-effort
    }
  });

  async function createArchiveBuffer(
    folderName: string,
    manifest: Record<string, unknown>,
  ): Promise<Buffer> {
    const archiveRoot = path.join(tempDir, "archive-root");
    const pluginRoot = path.join(archiveRoot, folderName);
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.mjs"),
      "export default class P { async onLoad() {} async onUnload() {} }\n",
    );

    const archivePath = path.join(tempDir, `${folderName}.tar.gz`);
    await tar.create({ gzip: true, file: archivePath, cwd: archiveRoot }, [folderName]);
    return fs.readFileSync(archivePath);
  }

  describe("install", () => {
    it("rejects non-HTTPS download URLs", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchSpy;

      const result = await installer.install("test-plugin", "http://example.com/plugin.tar.gz");

      expect(result.success).toBe(false);
      expect(result.error).toContain("HTTPS is required");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects localhost download targets", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchSpy;

      const result = await installer.install("test-plugin", "https://localhost/plugin.tar.gz");

      expect(result.success).toBe(false);
      expect(result.error).toContain('host "localhost" is not allowed');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects IPv4-mapped IPv6 private download targets", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchSpy;

      const result = await installer.install("test-plugin", "https://[::ffff:c0a8:0102]/plugin.tar.gz");

      expect(result.success).toBe(false);
      expect(result.error).toContain("local/private IPv6 ranges are not allowed");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects redirect responses to prevent SSRF bypass", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "http://localhost/internal" },
        }),
      );
      globalThis.fetch = fetchSpy;

      const result = await installer.install("test-plugin", "https://example.com/plugin.tar.gz");

      expect(result.success).toBe(false);
      expect(result.error).toContain("redirects are not allowed");
      expect(fetchSpy).toHaveBeenCalledWith("https://example.com/plugin.tar.gz", {
        redirect: "manual",
      });
    });

    it("rejects install when manifest ID mismatches requested pluginId", async () => {
      const archive = await createArchiveBuffer("plugin-folder", {
        id: "different-id",
        name: "Test Plugin",
        version: "1.0.0",
        author: "test",
        description: "test",
        main: "index.mjs",
        minJunbanVersion: "1.0.0",
      });

      globalThis.fetch = async () =>
        new Response(archive, {
          status: 200,
          headers: { "content-length": String(archive.length) },
        });

      const result = await installer.install(
        "requested-id",
        "https://example.com/plugin.tar.gz",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Manifest ID mismatch");
      expect(fs.existsSync(path.join(pluginDir, "requested-id"))).toBe(false);
    });

    it("rejects install when minJunbanVersion is incompatible", async () => {
      const archive = await createArchiveBuffer("plugin-folder", {
        id: "compat-check",
        name: "Compat Check",
        version: "1.0.0",
        author: "test",
        description: "test",
        main: "index.mjs",
        minJunbanVersion: "999.0.0",
      });

      globalThis.fetch = async () =>
        new Response(archive, {
          status: 200,
          headers: { "content-length": String(archive.length) },
        });

      const result = await installer.install(
        "compat-check",
        "https://example.com/plugin.tar.gz",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("requires Junban >= 999.0.0");
      expect(fs.existsSync(path.join(pluginDir, "compat-check"))).toBe(false);
    });
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
