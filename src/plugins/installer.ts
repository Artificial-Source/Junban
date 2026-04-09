import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";
import { PluginManifest } from "./types.js";
import { validateManifestVersionCompatibility } from "./compatibility.js";
import { validateOutboundNetworkUrl } from "./network-policy.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("plugin-installer");

/** Strict plugin ID pattern: lowercase alphanumeric + hyphens only. */
const VALID_PLUGIN_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Validate pluginId is safe for use in filesystem paths. */
function validatePluginId(pluginId: string): string | null {
  if (!pluginId || !VALID_PLUGIN_ID.test(pluginId)) {
    return `Invalid plugin ID "${pluginId}": must contain only lowercase letters, digits, and hyphens`;
  }
  return null;
}

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
    // Validate pluginId to prevent path traversal
    const idError = validatePluginId(pluginId);
    if (idError) return { success: false, error: idError };

    const targetDir = path.join(this.pluginDir, pluginId);

    // Check if already installed
    if (fs.existsSync(targetDir)) {
      return { success: false, error: `Plugin "${pluginId}" is already installed` };
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "junban-plugin-"));
    const tempFile = path.join(tempDir, "plugin.tar.gz");
    const tempExtractDir = path.join(tempDir, "extracted");

    try {
      validateOutboundNetworkUrl(downloadUrl, { context: "plugin install download", requireHttps: true });

      // Download the archive
      logger.info(`Downloading plugin "${pluginId}" from ${downloadUrl}`);
      const res = await fetch(downloadUrl, { redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        return {
          success: false,
          error: "Download failed: redirects are not allowed",
        };
      }
      if (!res.ok) {
        return { success: false, error: `Download failed: HTTP ${res.status}` };
      }
      if (!res.body) {
        return { success: false, error: "Download failed: empty response" };
      }

      // Enforce download size limit (50 MB)
      const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_SIZE) {
        return {
          success: false,
          error: `Plugin archive too large (max ${MAX_DOWNLOAD_SIZE / 1024 / 1024}MB)`,
        };
      }

      // Write to temp file
      const fileStream = fs.createWriteStream(tempFile);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pipeline(Readable.fromWeb(res.body as any), fileStream);

      // Verify actual file size after download
      const fileSize = fs.statSync(tempFile).size;
      if (fileSize > MAX_DOWNLOAD_SIZE) {
        return {
          success: false,
          error: `Plugin archive too large (max ${MAX_DOWNLOAD_SIZE / 1024 / 1024}MB)`,
        };
      }

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

      if (result.data.id !== pluginId) {
        return {
          success: false,
          error: `Manifest ID mismatch: requested "${pluginId}" but manifest declares "${result.data.id}"`,
        };
      }

      const compatibilityIssues = validateManifestVersionCompatibility(result.data);
      if (compatibilityIssues.length > 0) {
        return {
          success: false,
          error: compatibilityIssues.map((issue) => issue.message).join("; "),
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
    // Validate pluginId to prevent path traversal
    const idError = validatePluginId(pluginId);
    if (idError) return { success: false, error: idError };

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
