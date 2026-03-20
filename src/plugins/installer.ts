import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";
import { PluginManifest } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("plugin-installer");

export interface InstallResult {
  success: boolean;
  error?: string;
}

/**
 * Plugin installer — downloads and extracts plugin archives.
 */
export class PluginInstaller {
  constructor(private pluginDir: string) {}

  /** Download and install a plugin from a tar.gz URL. */
  async install(pluginId: string, downloadUrl: string): Promise<InstallResult> {
    const targetDir = path.join(this.pluginDir, pluginId);

    // Check if already installed
    if (fs.existsSync(targetDir)) {
      return { success: false, error: `Plugin "${pluginId}" is already installed` };
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "saydo-plugin-"));
    const tempFile = path.join(tempDir, "plugin.tar.gz");
    const tempExtractDir = path.join(tempDir, "extracted");

    try {
      // Download the archive
      logger.info(`Downloading plugin "${pluginId}" from ${downloadUrl}`);
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        return { success: false, error: `Download failed: HTTP ${res.status}` };
      }
      if (!res.body) {
        return { success: false, error: "Download failed: empty response" };
      }

      // Write to temp file
      const fileStream = fs.createWriteStream(tempFile);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeline(Readable.fromWeb(res.body as any), fileStream);

      // Extract — use filter to reject path traversal entries (zip slip)
      fs.mkdirSync(tempExtractDir, { recursive: true });
      await tar.extract({
        file: tempFile,
        cwd: tempExtractDir,
        filter: (entryPath: string) => {
          const resolved = path.resolve(tempExtractDir, entryPath);
          if (!resolved.startsWith(tempExtractDir + path.sep) && resolved !== tempExtractDir) {
            logger.warn(`Rejecting tar entry with path traversal: ${entryPath}`);
            return false;
          }
          return true;
        },
      });

      // Find manifest.json — could be in root or a subdirectory
      let manifestDir = tempExtractDir;
      const extractedEntries = fs.readdirSync(tempExtractDir);

      if (!extractedEntries.includes("manifest.json")) {
        // Check if there's a single subdirectory containing the manifest
        const subdirs = extractedEntries.filter((e) =>
          fs.statSync(path.join(tempExtractDir, e)).isDirectory(),
        );
        let found = false;
        for (const sub of subdirs) {
          const subPath = path.join(tempExtractDir, sub);
          if (fs.existsSync(path.join(subPath, "manifest.json"))) {
            manifestDir = subPath;
            found = true;
            break;
          }
        }
        if (!found) {
          return { success: false, error: "No manifest.json found in archive" };
        }
      }

      // Validate manifest
      const manifestRaw = JSON.parse(
        fs.readFileSync(path.join(manifestDir, "manifest.json"), "utf-8"),
      );
      const result = PluginManifest.safeParse(manifestRaw);
      if (!result.success) {
        return {
          success: false,
          error: `Invalid manifest: ${result.error.issues[0]?.message ?? "unknown error"}`,
        };
      }

      // Ensure plugins directory exists
      fs.mkdirSync(this.pluginDir, { recursive: true });

      // Move to final location
      fs.renameSync(manifestDir, targetDir);

      logger.info(`Installed plugin "${pluginId}" to ${targetDir}`);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: `Install failed: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    } finally {
      // Clean up temp files
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Non-critical
      }
    }
  }

  /** Uninstall a plugin by removing its directory. */
  async uninstall(pluginId: string): Promise<InstallResult> {
    const targetDir = path.join(this.pluginDir, pluginId);

    if (!fs.existsSync(targetDir)) {
      return { success: false, error: `Plugin "${pluginId}" is not installed` };
    }

    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      logger.info(`Uninstalled plugin "${pluginId}"`);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: `Uninstall failed: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  }
}
