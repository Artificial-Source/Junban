import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("pluginRoutes install/uninstall plugin directory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("uses resolved PLUGIN_DIR for install", async () => {
    const install = vi.fn().mockResolvedValue({ success: false, error: "install failed" });
    const uninstall = vi.fn();
    const PluginInstaller = vi.fn(
      class {
        install = install;
        uninstall = uninstall;
      },
    );

    vi.doMock("../../src/config/env.js", () => ({
      loadEnv: vi.fn(() => ({
        PLUGIN_DIR: "./custom-plugin-dir",
      })),
    }));

    vi.doMock("../../src/plugins/installer.js", () => ({ PluginInstaller }));

    const { pluginRoutes } = await import("../../src/api/plugins.js");

    const services = {
      pluginLoader: {
        discoverOne: vi.fn(),
        load: vi.fn(),
      },
    } as never;

    const app = pluginRoutes(services, {
      ensurePluginsLoaded: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const res = await app.request("http://localhost/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "calendar",
        downloadUrl: "https://example.com/calendar.tar.gz",
      }),
    });

    expect(res.status).toBe(200);
    expect(PluginInstaller).toHaveBeenCalledWith(path.resolve("./custom-plugin-dir"));
    expect(install).toHaveBeenCalledWith("calendar", "https://example.com/calendar.tar.gz");
  });

  it("uses resolved PLUGIN_DIR for uninstall", async () => {
    const install = vi.fn();
    const uninstall = vi.fn().mockResolvedValue({ success: true });
    const PluginInstaller = vi.fn(
      class {
        install = install;
        uninstall = uninstall;
      },
    );

    vi.doMock("../../src/config/env.js", () => ({
      loadEnv: vi.fn(() => ({
        PLUGIN_DIR: "./custom-plugin-dir",
      })),
    }));

    vi.doMock("../../src/plugins/installer.js", () => ({ PluginInstaller }));

    const { pluginRoutes } = await import("../../src/api/plugins.js");

    const deletePluginPermissions = vi.fn();
    const remove = vi.fn();

    const services = {
      pluginLoader: {
        get: vi.fn().mockReturnValue(undefined),
        unload: vi.fn().mockResolvedValue(undefined),
        remove,
      },
      storage: {
        deletePluginPermissions,
      },
    } as never;

    const app = pluginRoutes(services, {
      ensurePluginsLoaded: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const res = await app.request("http://localhost/calendar/uninstall", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(PluginInstaller).toHaveBeenCalledWith(path.resolve("./custom-plugin-dir"));
    expect(uninstall).toHaveBeenCalledWith("calendar");
    expect(deletePluginPermissions).toHaveBeenCalledWith("calendar");
    expect(remove).toHaveBeenCalledWith("calendar");
  });
});
