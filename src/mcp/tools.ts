/**
 * MCP tool registration.
 * Iterates all ToolRegistry definitions and registers each as an MCP tool,
 * delegating execution to toolRegistry.execute() — zero business logic duplication.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolRegistry } from "../ai/tools/registry.js";
import type { ToolContext } from "../ai/tools/types.js";
import { jsonSchemaToZod } from "./schema-converter.js";
import { toMcpError } from "./errors.js";

/** Register all ToolRegistry tools as MCP tools on the server. */
export function registerMcpTools(
  server: McpServer,
  toolRegistry: ToolRegistry,
  toolContext: ToolContext,
): void {
  const definitions = toolRegistry.getDefinitions();

  for (const def of definitions) {
    const zodShape = jsonSchemaToZod(def.parameters);

    server.registerTool(
      def.name,
      { description: def.description, inputSchema: zodShape },
      async (args) => {
        try {
          const result = await toolRegistry.execute(
            def.name,
            args as Record<string, unknown>,
            toolContext,
          );
          return {
            content: [{ type: "text" as const, text: result }],
          };
        } catch (err) {
          return toMcpError(err);
        }
      },
    );
  }
}
