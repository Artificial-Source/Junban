import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopRuntime = {
  mode: "default" as const,
  desktop: {
    apiBase: "http://127.0.0.1:7123/api",
    healthUrl: "http://127.0.0.1:7123/api/health",
    ready: true,
    service: "junban-backend",
  },
};

const unreadyDesktopRuntime = {
  mode: "default" as const,
  desktop: {
    apiBase: "",
    healthUrl: "",
    ready: false,
    service: "junban-backend",
    error: "Desktop backend sidecar failed to start.",
  },
};

async function loadHelpers({
  isTauri = false,
  runtimeConfig,
}: {
  isTauri?: boolean;
  runtimeConfig?: typeof desktopRuntime | { mode?: "default" | "remote-desktop" };
} = {}) {
  vi.resetModules();
  vi.doMock("../../../src/utils/tauri.js", () => ({
    isTauri: () => isTauri,
  }));

  window.__JUNBAN_RUNTIME__ = runtimeConfig;
  window.__JUNBAN_RUNTIME_READY__ = runtimeConfig ? Promise.resolve(runtimeConfig) : undefined;

  return import("../../../src/ui/api/helpers.js");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete window.__JUNBAN_RUNTIME__;
  delete window.__JUNBAN_RUNTIME_READY__;
});

describe("buildApiUrl", () => {
  it("builds relative API URLs with query params", async () => {
    const { buildApiUrl } = await loadHelpers();
    expect(
      buildApiUrl("/tasks", {
        search: "buy milk",
        status: "pending",
      }),
    ).toBe("/api/tasks?search=buy+milk&status=pending");
  });

  it("omits undefined params", async () => {
    const { buildApiUrl } = await loadHelpers();
    expect(
      buildApiUrl("/stats/daily", {
        startDate: "2026-04-01",
        endDate: undefined,
      }),
    ).toBe("/api/stats/daily?startDate=2026-04-01");
  });

  it("uses the packaged desktop sidecar base in Tauri mode", async () => {
    const { buildApiUrl } = await loadHelpers({ isTauri: true, runtimeConfig: desktopRuntime });

    expect(buildApiUrl("/tasks")).toBe("http://127.0.0.1:7123/api/tasks");
  });

  it("throws the runtime error when packaged desktop is marked unready", async () => {
    const { buildApiUrl } = await loadHelpers({
      isTauri: true,
      runtimeConfig: unreadyDesktopRuntime,
    });

    expect(() => buildApiUrl("/tasks")).toThrow("Desktop backend sidecar failed to start.");
  });
});

describe("useDirectServices", () => {
  it("uses backend fetches for remote-desktop browser runtime", async () => {
    const { useDirectServices, buildApiUrl } = await loadHelpers({
      runtimeConfig: { mode: "remote-desktop" },
    });

    expect(useDirectServices()).toBe(false);
    expect(buildApiUrl("/tasks")).toBe("/api/tasks");
  });

  it("uses backend fetches for packaged Tauri", async () => {
    const { useDirectServices } = await loadHelpers({ isTauri: true });

    expect(useDirectServices()).toBe(false);
  });

  it("uses backend fetches when VITE_USE_BACKEND is enabled", async () => {
    vi.stubEnv("VITE_USE_BACKEND", "true");
    const { useDirectServices, buildApiUrl } = await loadHelpers({ isTauri: true });

    expect(useDirectServices()).toBe(false);
    expect(buildApiUrl("/health")).toBe("/api/health");
  });
});

describe("waitForDesktopApiReady", () => {
  it("validates the Junban desktop backend health contract", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, service: "junban-backend" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { waitForDesktopApiReady } = await loadHelpers({
      isTauri: true,
      runtimeConfig: desktopRuntime,
    });

    await expect(waitForDesktopApiReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:7123/api/health");
  });

  it("rejects generic HTTP 200 responses from non-Junban backends", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, service: "someone-else" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { waitForDesktopApiReady } = await loadHelpers({
      isTauri: true,
      runtimeConfig: desktopRuntime,
    });

    const readyFailure = waitForDesktopApiReady().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(15100);

    await expect(readyFailure).resolves.toBeInstanceOf(Error);
    await expect(readyFailure).resolves.toMatchObject({
      message: expect.stringContaining("did not identify junban-backend"),
    });
    vi.useRealTimers();
  });

  it("surfaces the runtime descriptor error without polling when Tauri reports unready", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { waitForDesktopApiReady } = await loadHelpers({
      isTauri: true,
      runtimeConfig: unreadyDesktopRuntime,
    });

    await expect(waitForDesktopApiReady()).rejects.toThrow(
      "Desktop backend sidecar failed to start.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
