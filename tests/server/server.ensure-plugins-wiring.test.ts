import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

describe("server ensurePluginsLoaded wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("passes the runtime-backed ensure function to pluginRoutes and aiRoutes", async () => {
    const services = { marker: "services" };
    const runtime = {
      services,
      initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const pluginRoutes = vi.fn(() => new Hono());
    const aiRoutes = vi.fn(() => new Hono());

    vi.doMock("../../src/bootstrap.js", () => ({
      createNodeBackendRuntime: vi.fn(() => runtime),
    }));

    vi.doMock("../../src/config/env.js", () => ({
      loadEnv: vi.fn(() => ({ LOG_LEVEL: "info" })),
    }));

    vi.doMock("../../src/utils/logger.js", () => ({
      setDefaultLogLevel: vi.fn(),
      createLogger: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
      })),
    }));

    vi.doMock("../../src/core/errors.js", () => ({
      NotFoundError: class NotFoundError extends Error {},
      ValidationError: class ValidationError extends Error {},
    }));

    vi.doMock("@hono/node-server", () => ({
      serve: vi.fn(() => ({
        close: vi.fn(),
      })),
    }));

    vi.doMock("hono/cors", () => ({
      cors: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    }));

    vi.doMock("hono/secure-headers", () => ({
      secureHeaders: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    }));

    vi.doMock("hono/body-limit", () => ({
      bodyLimit: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    }));

    vi.doMock("../../src/api/tasks.js", () => ({ taskRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/projects.js", () => ({ projectRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/tags.js", () => ({ tagRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/sections.js", () => ({ sectionRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/comments.js", () => ({ commentRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/templates.js", () => ({ templateRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/settings.js", () => ({ settingsRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/stats.js", () => ({ statsRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/plugins.js", () => ({ pluginRoutes }));
    vi.doMock("../../src/api/ai.js", () => ({ aiRoutes }));
    vi.doMock("../../src/api/voice.js", () => ({ voiceRoutes: vi.fn(() => new Hono()) }));

    await import("../../src/server.js");

    expect(pluginRoutes).toHaveBeenCalledTimes(1);
    expect(aiRoutes).toHaveBeenCalledTimes(1);
    expect(pluginRoutes).toHaveBeenCalledWith(services, {
      ensurePluginsLoaded: expect.any(Function),
    });
    expect(aiRoutes).toHaveBeenCalledWith(services, {
      ensurePluginsLoaded: expect.any(Function),
    });

    const pluginEnsure = pluginRoutes.mock.calls[0]?.[1]?.ensurePluginsLoaded as
      | (() => Promise<void>)
      | undefined;
    const aiEnsure = aiRoutes.mock.calls[0]?.[1]?.ensurePluginsLoaded as
      | (() => Promise<void>)
      | undefined;

    expect(pluginEnsure).toBeTypeOf("function");
    expect(aiEnsure).toBe(pluginEnsure);

    await pluginEnsure?.();
    expect(runtime.initialize).toHaveBeenCalledTimes(2);
  });

  it("waits for server.close completion before runtime disposal on SIGTERM", async () => {
    let resolveDispose: (() => void) | undefined;
    const events: string[] = [];
    const runtime = {
      services: { marker: "services" },
      initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            events.push("dispose:start");
            resolveDispose = () => {
              events.push("dispose:end");
              resolve();
            };
          }),
      ),
    };

    let closeCallback: ((err?: Error) => void) | undefined;
    const close = vi.fn((cb: (err?: Error) => void) => {
      events.push("server:close");
      closeCallback = cb;
    });

    const signalHandlers = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => void,
    ) => {
      signalHandlers.set(event, handler);
      return process;
    }) as unknown as typeof process.on);

    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const forcedTimeout = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(global, "setTimeout").mockImplementation(
      ((..._args: unknown[]) => forcedTimeout) as unknown as typeof setTimeout,
    );

    vi.doMock("../../src/bootstrap.js", () => ({
      createNodeBackendRuntime: vi.fn(() => runtime),
    }));

    vi.doMock("../../src/config/env.js", () => ({
      loadEnv: vi.fn(() => ({ LOG_LEVEL: "info" })),
    }));

    vi.doMock("../../src/utils/logger.js", () => ({
      setDefaultLogLevel: vi.fn(),
      createLogger: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
      })),
    }));

    vi.doMock("../../src/core/errors.js", () => ({
      NotFoundError: class NotFoundError extends Error {},
      ValidationError: class ValidationError extends Error {},
    }));

    vi.doMock("@hono/node-server", () => ({
      serve: vi.fn(() => ({
        close,
      })),
    }));

    vi.doMock("hono/cors", () => ({
      cors: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    }));

    vi.doMock("hono/secure-headers", () => ({
      secureHeaders: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    }));

    vi.doMock("hono/body-limit", () => ({
      bodyLimit: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
    }));

    vi.doMock("../../src/api/tasks.js", () => ({ taskRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/projects.js", () => ({ projectRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/tags.js", () => ({ tagRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/sections.js", () => ({ sectionRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/comments.js", () => ({ commentRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/templates.js", () => ({ templateRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/settings.js", () => ({ settingsRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/stats.js", () => ({ statsRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/plugins.js", () => ({ pluginRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/ai.js", () => ({ aiRoutes: vi.fn(() => new Hono()) }));
    vi.doMock("../../src/api/voice.js", () => ({ voiceRoutes: vi.fn(() => new Hono()) }));

    await import("../../src/server.js");

    const sigterm = signalHandlers.get("SIGTERM");
    expect(sigterm).toBeTypeOf("function");

    sigterm?.();

    expect(events).toEqual(["server:close"]);
    expect(runtime.dispose).not.toHaveBeenCalled();

    closeCallback?.();

    await vi.waitFor(() => {
      expect(events).toEqual(["server:close", "dispose:start"]);
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    resolveDispose?.();

    await vi.waitFor(() => {
      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });

  it.each([
    {
      event: "uncaughtException",
      payload: new Error("boom"),
      expectedLog: "Uncaught exception: boom",
    },
    {
      event: "unhandledRejection",
      payload: "bad promise",
      expectedLog: "Unhandled rejection: bad promise",
    },
  ])(
    "routes $event through graceful shutdown and exits non-zero after teardown",
    async ({ event, payload, expectedLog }) => {
      let resolveDispose: (() => void) | undefined;
      const runtime = {
        services: { marker: "services" },
        initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        dispose: vi.fn<() => Promise<void>>(
          () =>
            new Promise<void>((resolve) => {
              resolveDispose = resolve;
            }),
        ),
      };

      let closeCallback: ((err?: Error) => void) | undefined;
      const close = vi.fn((cb: (err?: Error) => void) => {
        closeCallback = cb;
      });

      const signalHandlers = new Map<string, (...args: unknown[]) => void>();
      vi.spyOn(process, "on").mockImplementation(((
        processEvent: string,
        handler: (...args: unknown[]) => void,
      ) => {
        signalHandlers.set(processEvent, handler);
        return process;
      }) as unknown as typeof process.on);

      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      const forcedTimeout = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      vi.spyOn(global, "setTimeout").mockImplementation(
        ((..._args: unknown[]) => forcedTimeout) as unknown as typeof setTimeout,
      );

      const info = vi.fn();
      const error = vi.fn();

      vi.doMock("../../src/bootstrap.js", () => ({
        createNodeBackendRuntime: vi.fn(() => runtime),
      }));

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

      vi.doMock("../../src/core/errors.js", () => ({
        NotFoundError: class NotFoundError extends Error {},
        ValidationError: class ValidationError extends Error {},
      }));

      vi.doMock("@hono/node-server", () => ({
        serve: vi.fn(() => ({
          close,
        })),
      }));

      vi.doMock("hono/cors", () => ({
        cors: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
      }));

      vi.doMock("hono/secure-headers", () => ({
        secureHeaders: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
      }));

      vi.doMock("hono/body-limit", () => ({
        bodyLimit: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
      }));

      vi.doMock("../../src/api/tasks.js", () => ({ taskRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/projects.js", () => ({ projectRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/tags.js", () => ({ tagRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/sections.js", () => ({ sectionRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/comments.js", () => ({ commentRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/templates.js", () => ({ templateRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/settings.js", () => ({ settingsRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/stats.js", () => ({ statsRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/plugins.js", () => ({ pluginRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/ai.js", () => ({ aiRoutes: vi.fn(() => new Hono()) }));
      vi.doMock("../../src/api/voice.js", () => ({ voiceRoutes: vi.fn(() => new Hono()) }));

      await import("../../src/server.js");

      const handler = signalHandlers.get(event);
      expect(handler).toBeTypeOf("function");

      handler?.(payload);

      expect(error).toHaveBeenCalledWith(expectedLog);
      expect(close).toHaveBeenCalledTimes(1);
      expect(runtime.dispose).not.toHaveBeenCalled();
      expect(process.exit).not.toHaveBeenCalled();

      closeCallback?.();
      await vi.waitFor(() => {
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
      });
      expect(process.exit).not.toHaveBeenCalled();

      resolveDispose?.();

      await vi.waitFor(() => {
        expect(process.exit).toHaveBeenCalledWith(1);
      });
    },
  );
});
