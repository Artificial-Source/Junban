#!/usr/bin/env node
/**
 * ASF Saydo MCP Server — stdio entry point.
 *
 * Exposes all Saydo tools, resources, and prompts over the MCP protocol.
 * Designed for Claude Desktop and other MCP-compatible clients.
 *
 * Usage:
 *   pnpm mcp
 *   # or: node --loader tsx src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "../bootstrap.js";
import { createToolContext } from "./context.js";
import { registerMcpTools } from "./tools.js";
import { registerMcpResources } from "./resources.js";
import { registerMcpPrompts } from "./prompts.js";

// Redirect console to stderr — MCP stdio transport requires only JSON-RPC on stdout.
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
console.warn = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
console.info = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

async function main(): Promise<void> {
  // Bootstrap services (same pattern as CLI)
  const services = bootstrap();

  // Load plugins so plugin-contributed tools (e.g. timeblocking auto-schedule) are registered
  await services.pluginLoader.loadAll();

  const toolContext = createToolContext(services);

  // Create MCP server
  const server = new McpServer({
    name: "saydo",
    version: "1.0.0",
  });

  // Register all tools, resources, and prompts
  registerMcpTools(server, services.toolRegistry, toolContext);
  registerMcpResources(server, services);
  registerMcpPrompts(server);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Restore console after connection (for clean shutdown messages)
  process.on("SIGINT", () => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.info = originalConsoleInfo;
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`Saydo MCP server error: ${err}\n`);
  process.exit(1);
});
