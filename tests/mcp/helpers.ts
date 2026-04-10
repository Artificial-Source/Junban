/**
 * Test helpers for MCP integration tests.
 * Sets up a McpServer + Client pair connected via InMemoryTransport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestServices } from "../integration/helpers.js";
import { createDefaultToolRegistry } from "../../src/ai/tool-registry.js";
import { StatsService } from "../../src/core/stats.js";
import { registerMcpTools } from "../../src/mcp/tools.js";
import { registerMcpResources } from "../../src/mcp/resources.js";
import { registerMcpPrompts } from "../../src/mcp/prompts.js";
import type { ToolContext } from "../../src/ai/tools/types.js";
import type { AppServices } from "../../src/bootstrap.js";

export async function createMcpTestEnv() {
  // Create base test services
  const base = createTestServices();
  const statsService = new StatsService(base.storage);
  const toolRegistry = createDefaultToolRegistry();

  // Build a minimal AppServices-like object for resource registration
  const services = {
    ...base,
    statsService,
    toolRegistry,
  } as unknown as AppServices;

  const toolContext: ToolContext = {
    taskService: base.taskService,
    projectService: base.projectService,
    tagService: base.tagService,
    statsService,
  };

  // Create MCP server
  const server = new McpServer({ name: "junban-test", version: "1.0.0" });

  // Register everything
  registerMcpTools(server, toolRegistry, toolContext);
  registerMcpResources(server, services);
  registerMcpPrompts(server);

  // Create linked transports
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Create client
  const client = new Client({ name: "test-client", version: "1.0.0" });

  // Connect both sides
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    services: base,
    statsService,
    toolRegistry,
    toolContext,
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}
