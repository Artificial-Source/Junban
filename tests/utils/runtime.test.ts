// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const readyRuntime = {
  mode: "default" as const,
  desktop: {
    apiBase: "http://127.0.0.1:7001/api",
    healthUrl: "http://127.0.0.1:7001/api/health",
    ready: true,
    service: "junban-backend",
  },
};

describe("runtime descriptor synchronization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete window.__JUNBAN_RUNTIME__;
    delete window.__JUNBAN_RUNTIME_READY__;
  });

  it("subscribes to desktop runtime descriptor changes in packaged Tauri mode", async () => {
    const listenMock = vi.fn(async () => vi.fn());

    vi.doMock("../../src/utils/tauri.js", () => ({
      isTauri: () => true,
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));

    window.__JUNBAN_RUNTIME__ = readyRuntime;
    window.__JUNBAN_RUNTIME_READY__ = Promise.resolve(readyRuntime);

    const runtime = await import("../../src/utils/runtime.js");
    await runtime.waitForRuntimeConfig();

    expect(listenMock).toHaveBeenCalledWith(
      runtime.DESKTOP_RUNTIME_DESCRIPTOR_CHANGED_EVENT,
      expect.any(Function),
    );
  });

  it("refreshes window runtime when a desktop runtime update event arrives", async () => {
    let onRuntimeUpdate: ((event: { payload: typeof readyRuntime }) => void) | null = null;
    const listenMock = vi.fn(async (_eventName: string, handler: typeof onRuntimeUpdate) => {
      onRuntimeUpdate = handler;
      return vi.fn();
    });

    vi.doMock("../../src/utils/tauri.js", () => ({
      isTauri: () => true,
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));

    window.__JUNBAN_RUNTIME__ = readyRuntime;
    window.__JUNBAN_RUNTIME_READY__ = Promise.resolve(readyRuntime);

    const runtime = await import("../../src/utils/runtime.js");
    await runtime.waitForRuntimeConfig();

    const updatedRuntime = {
      mode: "default" as const,
      desktop: {
        apiBase: "http://127.0.0.1:7001/api",
        healthUrl: "http://127.0.0.1:7001/api/health",
        ready: false,
        service: "junban-backend",
        error: "Desktop backend exited with code Some(1) signal None",
      },
    };

    onRuntimeUpdate?.({ payload: updatedRuntime });

    expect(window.__JUNBAN_RUNTIME__).toEqual(updatedRuntime);
    await expect(window.__JUNBAN_RUNTIME_READY__).resolves.toEqual(updatedRuntime);
    expect(runtime.getDesktopApiRuntime()?.ready).toBe(false);
    expect(runtime.getDesktopApiRuntime()?.error).toContain("exited");
  });

  it("re-reads the Tauri runtime descriptor when startup receives an empty descriptor", async () => {
    const listenMock = vi.fn(async () => vi.fn());
    const invokeMock = vi.fn(async () => readyRuntime);

    vi.doMock("../../src/utils/tauri.js", () => ({
      isTauri: () => true,
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: invokeMock,
    }));

    const initialRuntime = { mode: "default" as const };
    window.__JUNBAN_RUNTIME__ = initialRuntime;
    window.__JUNBAN_RUNTIME_READY__ = Promise.resolve(initialRuntime);

    const runtime = await import("../../src/utils/runtime.js");
    await expect(runtime.waitForRuntimeConfig()).resolves.toEqual(readyRuntime);

    expect(invokeMock).toHaveBeenCalledWith("desktop_runtime_descriptor");
    expect(window.__JUNBAN_RUNTIME__).toEqual(readyRuntime);
    expect(runtime.getDesktopApiRuntime()?.apiBase).toBe("http://127.0.0.1:7001/api");
  });

  it("retries the Tauri runtime descriptor until the desktop runtime is available", async () => {
    vi.useFakeTimers();
    const listenMock = vi.fn(async () => vi.fn());
    const initialRuntime = { mode: "default" as const };
    const invokeMock = vi
      .fn()
      .mockResolvedValueOnce(initialRuntime)
      .mockResolvedValueOnce(readyRuntime);

    vi.doMock("../../src/utils/tauri.js", () => ({
      isTauri: () => true,
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: invokeMock,
    }));

    window.__JUNBAN_RUNTIME__ = initialRuntime;
    window.__JUNBAN_RUNTIME_READY__ = Promise.resolve(initialRuntime);

    const runtime = await import("../../src/utils/runtime.js");
    const waitForConfig = runtime.waitForRuntimeConfig();
    await vi.advanceTimersByTimeAsync(100);

    await expect(waitForConfig).resolves.toEqual(readyRuntime);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not overwrite a runtime update event with a stale descriptor response", async () => {
    let onRuntimeUpdate: ((event: { payload: typeof readyRuntime }) => void) | null = null;
    let resolveInvoke: ((value: { mode: "default" }) => void) | null = null;
    const initialRuntime = { mode: "default" as const };
    const listenMock = vi.fn(async (_eventName: string, handler: typeof onRuntimeUpdate) => {
      onRuntimeUpdate = handler;
      return vi.fn();
    });
    const invokeMock = vi.fn(
      () => new Promise<typeof initialRuntime>((resolve) => (resolveInvoke = resolve)),
    );

    vi.doMock("../../src/utils/tauri.js", () => ({
      isTauri: () => true,
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: listenMock,
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: invokeMock,
    }));

    window.__JUNBAN_RUNTIME__ = initialRuntime;
    window.__JUNBAN_RUNTIME_READY__ = Promise.resolve(initialRuntime);

    const runtime = await import("../../src/utils/runtime.js");
    const waitForConfig = runtime.waitForRuntimeConfig();

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("desktop_runtime_descriptor"));
    onRuntimeUpdate?.({ payload: readyRuntime });
    resolveInvoke?.(initialRuntime);

    await expect(waitForConfig).resolves.toEqual(readyRuntime);
    expect(window.__JUNBAN_RUNTIME__).toEqual(readyRuntime);
  });
});
