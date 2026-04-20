import { describe, expect, it, vi } from "vitest";
import type { AppServices } from "../../src/backend/kernel.js";
import { NodeBackendRuntime } from "../../src/backend/node-runtime.js";

describe("NodeBackendRuntime", () => {
  it("initializes and disposes plugin lifecycle once per phase", async () => {
    const loadAll = vi.fn(async () => undefined);
    const unloadAll = vi.fn(async () => undefined);
    const getAll = vi
      .fn()
      .mockReturnValueOnce([{ enabled: true }])
      .mockReturnValueOnce([{ enabled: true }])
      .mockReturnValueOnce([{ enabled: true }])
      .mockReturnValue([{ enabled: false }]);

    const runtime = new NodeBackendRuntime({
      pluginLoader: {
        loadAll,
        unloadAll,
        getAll,
      },
    } as unknown as AppServices);

    await runtime.initialize();
    await runtime.initialize();
    expect(loadAll).toHaveBeenCalledTimes(1);

    await runtime.dispose();
    await runtime.dispose();
    expect(unloadAll).toHaveBeenCalledTimes(1);
  });

  it("treats a zero-enabled plugin load as initialized until dispose", async () => {
    const loadAll = vi.fn(async () => undefined);
    const unloadAll = vi.fn(async () => undefined);
    const getAll = vi.fn().mockReturnValue([]);

    const runtime = new NodeBackendRuntime({
      pluginLoader: {
        loadAll,
        unloadAll,
        getAll,
      },
    } as unknown as AppServices);

    await runtime.initialize();
    await runtime.initialize();

    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(unloadAll).not.toHaveBeenCalled();

    await runtime.dispose();
    await runtime.initialize();

    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it("unloads plugins enabled after startup", async () => {
    const loadAll = vi.fn(async () => undefined);
    const unloadAll = vi.fn(async () => undefined);
    const getAll = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValue([{ enabled: true }]);

    const runtime = new NodeBackendRuntime({
      pluginLoader: {
        loadAll,
        unloadAll,
        getAll,
      },
    } as unknown as AppServices);

    await runtime.initialize();
    await runtime.dispose();

    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(unloadAll).toHaveBeenCalledTimes(1);
  });

  it("rethrows startup failures and allows a later retry", async () => {
    const loadAll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("init failed"))
      .mockResolvedValueOnce(undefined);
    const unloadAll = vi.fn(async () => undefined);
    const getAll = vi.fn().mockReturnValue([]);

    const runtime = new NodeBackendRuntime({
      pluginLoader: {
        loadAll,
        unloadAll,
        getAll,
      },
    } as unknown as AppServices);

    await expect(runtime.initialize()).rejects.toThrow("init failed");
    await expect(runtime.initialize()).resolves.toBeUndefined();

    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it("can dispose partially active plugins after failed startup", async () => {
    const loadAll = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("init failed"));
    const unloadAll = vi.fn(async () => undefined);
    const getAll = vi.fn().mockReturnValue([{ enabled: true }]);

    const runtime = new NodeBackendRuntime({
      pluginLoader: {
        loadAll,
        unloadAll,
        getAll,
      },
    } as unknown as AppServices);

    await expect(runtime.initialize()).rejects.toThrow("init failed");
    await runtime.dispose();

    expect(unloadAll).toHaveBeenCalledTimes(1);
  });

  it("continues dispose when initialize is in flight and later rejects", async () => {
    let rejectInitialize: ((reason?: unknown) => void) | undefined;
    const loadAll = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInitialize = reject;
        }),
    );
    const unloadAll = vi.fn(async () => undefined);
    const getAll = vi.fn().mockReturnValue([{ enabled: true }]);

    const runtime = new NodeBackendRuntime({
      pluginLoader: {
        loadAll,
        unloadAll,
        getAll,
      },
    } as unknown as AppServices);

    const initializePromise = runtime.initialize();
    const disposePromise = runtime.dispose();

    rejectInitialize?.(new Error("init failed"));

    await expect(initializePromise).rejects.toThrow("init failed");
    await expect(disposePromise).resolves.toBeUndefined();

    expect(unloadAll).toHaveBeenCalledTimes(1);
  });
});
