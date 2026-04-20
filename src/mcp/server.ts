#!/usr/bin/env node
/**
 * ASF Junban MCP Server — stdio entry point.
 *
 * Exposes all Junban tools, resources, and prompts over the MCP protocol.
 * Designed for Claude Desktop and other MCP-compatible clients.
 *
 * Usage:
 *   pnpm mcp
 *   # or: node --loader tsx src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNodeBackendRuntime } from "../bootstrap.js";
import { createToolContext } from "./context.js";
import { registerMcpTools } from "./tools.js";
import { registerMcpResources } from "./resources.js";
import { registerMcpPrompts } from "./prompts.js";

const FORCED_SHUTDOWN_TIMEOUT_MS = 5000;

// Redirect console to stderr — MCP stdio transport requires only JSON-RPC on stdout.
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
console.warn = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
console.info = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

function restoreConsole(): void {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.info = originalConsoleInfo;
}

async function main(): Promise<void> {
  const runtime = createNodeBackendRuntime();
  const { services } = runtime;

  let shuttingDown: Promise<void> | null = null;
  let shutdownExitCode = 0;

  async function shutdown(signal: string, requestedExitCode = 0): Promise<void> {
    shutdownExitCode = Math.max(shutdownExitCode, requestedExitCode);

    if (shuttingDown) {
      return shuttingDown;
    }

    shuttingDown = (async () => {
      process.stderr.write(`${signal} received, shutting down MCP server...\n`);

      // Force exit after 5s if graceful shutdown stalls.
      const forceExitTimer = setTimeout(() => {
        restoreConsole();
        process.stderr.write(
          `MCP shutdown timed out after ${FORCED_SHUTDOWN_TIMEOUT_MS}ms; forcing exit.\n`,
        );
        process.exit(1);
      }, FORCED_SHUTDOWN_TIMEOUT_MS);
      forceExitTimer.unref();

      try {
        await runtime.dispose();
        clearTimeout(forceExitTimer);
        restoreConsole();
        process.exit(shutdownExitCode);
      } catch (err) {
        clearTimeout(forceExitTimer);
        restoreConsole();
        process.stderr.write(
          `Junban MCP shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    })();

    return shuttingDown;
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `Uncaught exception: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`Unhandled rejection: ${String(reason)}\n`);
    void shutdown("unhandledRejection", 1);
  });

  await runtime.initialize();

  const toolContext = createToolContext(services);

  // Create MCP server
  const server = new McpServer({
    name: "junban",
    version: "1.0.0",
  });

  // Register all tools, resources, and prompts
  registerMcpTools(server, services.toolRegistry, toolContext);
  registerMcpResources(server, services);
  registerMcpPrompts(server);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  restoreConsole();
  process.stderr.write(`Junban MCP server error: ${err}\n`);
  process.exit(1);
});
