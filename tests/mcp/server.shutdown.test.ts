import { beforeEach, describe, expect, it, vi } from "vitest";

describe("mcp server shutdown ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("disposes runtime once on repeated signals with forced-timeout guard", async () => {
    let resolveDispose: (() => void) | undefined;

    const runtime = {
      services: { toolRegistry: { marker: "registry" } },
      initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            resolveDispose = resolve;
          }),
      ),
    };

    const signalHandlers = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => void,
    ) => {
      signalHandlers.set(event, handler);
      return process;
    }) as unknown as typeof process.on);

    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);

    const forcedTimeout = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(global, "setTimeout").mockImplementation(
      ((..._args: unknown[]) => forcedTimeout) as unknown as typeof setTimeout,
    );

    const connect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    vi.doMock("../../src/bootstrap.js", () => ({
      createNodeBackendRuntime: vi.fn(() => runtime),
    }));

    vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
      McpServer: vi.fn(() => ({ connect })),
    }));

    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: vi.fn(() => ({ marker: "stdio" })),
    }));

    vi.doMock("../../src/mcp/context.js", () => ({
      createToolContext: vi.fn(() => ({ marker: "tool-context" })),
    }));

    vi.doMock("../../src/mcp/tools.js", () => ({
      registerMcpTools: vi.fn(),
    }));

    vi.doMock("../../src/mcp/resources.js", () => ({
      registerMcpResources: vi.fn(),
    }));

    vi.doMock("../../src/mcp/prompts.js", () => ({
      registerMcpPrompts: vi.fn(),
    }));

    await import("../../src/mcp/server.js");

    vi.mocked(process.exit).mockClear();
    stderrWrite.mockClear();

    const sigterm = signalHandlers.get("SIGTERM");
    expect(sigterm).toBeTypeOf("function");

    sigterm?.();
    sigterm?.();

    await vi.waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(global.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(forcedTimeout.unref).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();

    resolveDispose?.();

    await vi.waitFor(() => {
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    expect(stderrWrite).toHaveBeenCalledWith("SIGTERM received, shutting down MCP server...\n");
  });

  it("exits non-zero when runtime disposal fails", async () => {
    const runtime = {
      services: { toolRegistry: { marker: "registry" } },
      initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dispose: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("dispose failed")),
    };

    const signalHandlers = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => void,
    ) => {
      signalHandlers.set(event, handler);
      return process;
    }) as unknown as typeof process.on);

    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);

    const forcedTimeout = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(global, "setTimeout").mockImplementation(
      ((..._args: unknown[]) => forcedTimeout) as unknown as typeof setTimeout,
    );

    vi.doMock("../../src/bootstrap.js", () => ({
      createNodeBackendRuntime: vi.fn(() => runtime),
    }));

    vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
      McpServer: vi.fn(() => ({ connect: vi.fn().mockResolvedValue(undefined) })),
    }));

    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: vi.fn(() => ({ marker: "stdio" })),
    }));

    vi.doMock("../../src/mcp/context.js", () => ({
      createToolContext: vi.fn(() => ({ marker: "tool-context" })),
    }));

    vi.doMock("../../src/mcp/tools.js", () => ({
      registerMcpTools: vi.fn(),
    }));

    vi.doMock("../../src/mcp/resources.js", () => ({
      registerMcpResources: vi.fn(),
    }));

    vi.doMock("../../src/mcp/prompts.js", () => ({
      registerMcpPrompts: vi.fn(),
    }));

    await import("../../src/mcp/server.js");

    const sigint = signalHandlers.get("SIGINT");
    expect(sigint).toBeTypeOf("function");

    sigint?.();

    await vi.waitFor(() => {
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    expect(stderrWrite).toHaveBeenCalledWith("Junban MCP shutdown failed: dispose failed\n");
  });
});
