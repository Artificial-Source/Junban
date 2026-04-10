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
});
