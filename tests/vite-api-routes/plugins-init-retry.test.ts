import { beforeEach, describe, expect, it, vi } from "vitest";

describe("vite plugin route initialization retry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clears failed init promise so ensurePlugins can retry", async () => {
    const { createEnsurePlugins } = await import("../../vite-api-routes/plugins.js");

    const loadAll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("vite init failed"))
      .mockResolvedValueOnce(undefined);
    const setModuleLoader = vi.fn();
    const getServices = vi.fn(async () => ({
      pluginLoader: {
        setModuleLoader,
        loadAll,
      },
    }));

    const server = {
      ssrLoadModule: vi.fn(),
    } as any;

    const ensurePlugins = createEnsurePlugins(server, getServices);

    await expect(ensurePlugins()).rejects.toThrow("vite init failed");
    await expect(ensurePlugins()).resolves.toBeUndefined();

    expect(loadAll).toHaveBeenCalledTimes(2);
  });
});
