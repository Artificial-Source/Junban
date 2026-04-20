import { beforeEach, describe, expect, it, vi } from "vitest";

describe("main startup plugin initialization policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("logs initialize failures without terminating module startup", async () => {
    const initialize = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("init failed"));
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const runtime = {
      initialize,
      dispose,
      services: { marker: "ok" },
    };

    const info = vi.fn();
    const error = vi.fn();

    vi.doMock("../../src/config/env.js", () => ({
      loadEnv: vi.fn(() => ({ LOG_LEVEL: "info" })),
    }));

    vi.doMock("../../src/utils/logger.js", () => ({
      setDefaultLogLevel: vi.fn(),
      createLogger: vi.fn(() => ({
        info,
        error,
      })),
    }));

    vi.doMock("../../src/bootstrap.js", () => ({
      createNodeBackendRuntime: vi.fn(() => runtime),
    }));

    const mainModule = await import("../../src/main.js");

    expect(mainModule.runtime).toBe(runtime);
    expect(mainModule.services).toBe(runtime.services);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "Plugin startup failed during app bootstrap",
    );
  });

  it("owns runtime disposal on signals and runs shutdown once", async () => {
    const initialize = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const runtime = {
      initialize,
      dispose,
      services: { marker: "ok" },
    };

    const info = vi.fn();
    const error = vi.fn();

    const signalHandlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      signalHandlers.set(event, handler);
      return process;
    }) as unknown as typeof process.on);

    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const forcedTimeout = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(global, "setTimeout").mockImplementation(
      ((..._args: unknown[]) => forcedTimeout) as unknown as typeof setTimeout,
    );

    vi.doMock("../../src/config/env.js", () => ({
      loadEnv: vi.fn(() => ({ LOG_LEVEL: "info" })),
    }));

    vi.doMock("../../src/utils/logger.js", () => ({
      setDefaultLogLevel: vi.fn(),
      createLogger: vi.fn(() => ({
        info,
        error,
      })),
    }));

    vi.doMock("../../src/bootstrap.js", () => ({
      createNodeBackendRuntime: vi.fn(() => runtime),
    }));

    await import("../../src/main.js");

    const sigint = signalHandlers.get("SIGINT");
    expect(sigint).toBeTypeOf("function");

    sigint?.();
    sigint?.();

    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });
});
