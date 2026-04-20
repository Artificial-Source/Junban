import { describe, expect, it, vi } from "vitest";
import { pluginRoutes } from "../../src/api/plugins.js";

describe("pluginRoutes initialization retry", () => {
  it("retries plugin initialization after an initial failure", async () => {
    const loadAll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("init failed"))
      .mockResolvedValueOnce(undefined);

    const services = {
      pluginLoader: {
        loadAll,
        getAll: vi.fn().mockReturnValue([]),
      },
      commandRegistry: {
        getAll: vi.fn().mockReturnValue([]),
      },
      uiRegistry: {
        getStatusBarItems: vi.fn().mockReturnValue([]),
        getPanels: vi.fn().mockReturnValue([]),
        getPanelContent: vi.fn(),
        getViewContent: vi.fn(),
        getViews: vi.fn().mockReturnValue([]),
      },
      taskService: { list: vi.fn() },
      settingsManager: { get: vi.fn(), setSetting: vi.fn(), getAll: vi.fn() },
      storage: {
        getPluginPermissions: vi.fn().mockReturnValue(null),
        deletePluginPermissions: vi.fn(),
      },
    } as any;

    const app = pluginRoutes(services);

    const first = await app.request(new Request("http://localhost/commands"));
    expect(first.status).toBe(500);

    const second = await app.request(new Request("http://localhost/commands"));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual([]);

    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it("uses injected ensurePluginsLoaded when provided", async () => {
    const loadAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const ensurePluginsLoaded = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const services = {
      pluginLoader: {
        loadAll,
        getAll: vi.fn().mockReturnValue([]),
      },
      commandRegistry: {
        getAll: vi.fn().mockReturnValue([]),
      },
      uiRegistry: {
        getStatusBarItems: vi.fn().mockReturnValue([]),
        getPanels: vi.fn().mockReturnValue([]),
        getPanelContent: vi.fn(),
        getViewContent: vi.fn(),
        getViews: vi.fn().mockReturnValue([]),
      },
      taskService: { list: vi.fn() },
      settingsManager: { get: vi.fn(), setSetting: vi.fn(), getAll: vi.fn() },
      storage: {
        getPluginPermissions: vi.fn().mockReturnValue(null),
        deletePluginPermissions: vi.fn(),
      },
    } as any;

    const app = pluginRoutes(services, { ensurePluginsLoaded });
    const res = await app.request(new Request("http://localhost/commands"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
    expect(ensurePluginsLoaded).toHaveBeenCalledTimes(1);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it("retries through injected ensurePluginsLoaded after startup failure", async () => {
    const loadAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const ensurePluginsLoaded = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);

    const services = {
      pluginLoader: {
        loadAll,
        getAll: vi.fn().mockReturnValue([]),
      },
      commandRegistry: {
        getAll: vi.fn().mockReturnValue([]),
      },
      uiRegistry: {
        getStatusBarItems: vi.fn().mockReturnValue([]),
        getPanels: vi.fn().mockReturnValue([]),
        getPanelContent: vi.fn(),
        getViewContent: vi.fn(),
        getViews: vi.fn().mockReturnValue([]),
      },
      taskService: { list: vi.fn() },
      settingsManager: { get: vi.fn(), setSetting: vi.fn(), getAll: vi.fn() },
      storage: {
        getPluginPermissions: vi.fn().mockReturnValue(null),
        deletePluginPermissions: vi.fn(),
      },
    } as any;

    const app = pluginRoutes(services, { ensurePluginsLoaded });

    const first = await app.request(new Request("http://localhost/commands"));
    expect(first.status).toBe(500);

    const second = await app.request(new Request("http://localhost/commands"));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual([]);

    expect(ensurePluginsLoaded).toHaveBeenCalledTimes(2);
    expect(loadAll).not.toHaveBeenCalled();
  });
});
