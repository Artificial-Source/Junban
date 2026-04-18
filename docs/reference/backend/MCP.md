# MCP Server — Internal Documentation

The MCP (Model Context Protocol) server (`src/mcp/`) exposes Junban's task management capabilities to external AI agents and apps. Any MCP-compatible client — Claude Desktop, personal assistants, other ASF apps, or custom agents — can manage tasks, projects, tags, and get productivity insights over a local stdio connection.

This document describes the MCP surface area and integration model. Exact tool counts should follow the AI tool registry rather than being hardcoded in multiple places.

---

## Architecture Overview

```
External MCP Client (Claude Desktop, custom agent, etc.)
    |
    | JSON-RPC over stdio
    v
src/mcp/server.ts  (entry point)
    |
    ├── registerMcpTools()      → ToolRegistry (all registered AI tools)
    ├── registerMcpResources()  → TaskService, ProjectService, TagService, StatsService
    └── registerMcpPrompts()    → pre-built conversation starters
    |
    v
bootstrap() → AppServices (same as CLI and web app)
```

The MCP server reuses the exact same `bootstrap()` and `ToolRegistry` as the CLI and web app — zero business logic duplication.

---

## Running the MCP Server

```bash
pnpm mcp
```

This starts the server on stdio (JSON-RPC). Use it as a manual smoke test or for clients that expect you to start the server yourself. Claude Desktop and similar stdio clients can launch the process from config instead.

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "junban": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/junban", "mcp"]
    }
  }
}
```

For a custom agent using the MCP SDK, `StdioClientTransport` launches `pnpm mcp` for you:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--dir", "/path/to/junban", "mcp"],
});

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Create a task
await client.callTool({
  name: "create_task",
  arguments: { title: "Buy groceries", priority: 2 },
});

// Read today's tasks
const today = await client.readResource({ uri: "junban://tasks/today" });
```

---

## Files

### `server.ts`

**Path:** `src/mcp/server.ts`
**Purpose:** Entry point. Redirects `console.log`/`console.warn`/`console.info` to stderr (stdio MCP requirement — only JSON-RPC on stdout). Calls `bootstrap()` to initialize services, creates `McpServer`, registers tools/resources/prompts, connects via `StdioServerTransport`.
**Key Dependencies:** `bootstrap`, `McpServer`, `StdioServerTransport`

### `tools.ts`

**Path:** `src/mcp/tools.ts`
**Purpose:** Registers all `ToolRegistry` tools as MCP tools. Iterates `toolRegistry.getDefinitions()`, converts each tool's JSON Schema parameters to a Zod shape via `jsonSchemaToZod()`, and delegates execution to `toolRegistry.execute()`.
**Key Exports:**

- `registerMcpTools(server, toolRegistry, toolContext)` — registers all tools on the MCP server
  **Key Dependencies:** `ToolRegistry`, `jsonSchemaToZod`, `toMcpError`

### `resources.ts`

**Path:** `src/mcp/resources.ts`
**Purpose:** Registers MCP resources for read-only task, project, tag, and stats access (static resources plus dynamic templates).
**Key Exports:**

- `registerMcpResources(server, services)` — registers all resources
  **Key Dependencies:** `AppServices`, `McpServer`, `ResourceTemplate`

### `prompts.ts`

**Path:** `src/mcp/prompts.ts`
**Purpose:** Registers pre-built prompts for common productivity workflows.
**Key Exports:**

- `registerMcpPrompts(server)` — registers all prompts
  **Key Dependencies:** `McpServer`, `zod`

### `schema-converter.ts`

**Path:** `src/mcp/schema-converter.ts`
**Purpose:** Converts JSON Schema objects (as used by `ToolDefinition.parameters`) to Zod raw shapes for `McpServer.registerTool()`. Handles the subset used by our tools: string, number, integer, boolean, array (of strings), enum, required, description.
**Key Exports:**

- `jsonSchemaToZod(schema)` — returns `Record<string, z.ZodTypeAny>`

### `context.ts`

**Path:** `src/mcp/context.ts`
**Purpose:** Factory that extracts a `ToolContext` from `AppServices`.
**Key Exports:**

- `createToolContext(services)` — returns `{ taskService, projectService, tagService, statsService }`

### `errors.ts`

**Path:** `src/mcp/errors.ts`
**Purpose:** Maps Junban error classes to MCP error responses with `isError: true`.
**Key Exports:**

- `toMcpError(err)` — returns `{ content: [{ type: "text", text }], isError: true }`

---

## Tools

All tools from `ToolRegistry` are exposed as MCP tools with identical names, descriptions, and parameter schemas.

To avoid drift, treat `src/ai/tool-registry.ts` as the source of truth for the complete tool inventory. This MCP layer intentionally mirrors that registry instead of maintaining a second hardcoded list.

Tool families exposed through MCP include task management, projects, reminders, tags, organization helpers, analytics, and planning. See [AI.md](AI.md) for per-tool behavior.

---

## Resources

Resources are registered in `src/mcp/resources.ts`. The server exposes a mix of static URIs and dynamic URI templates.

Treat that module as the source of truth for the full resource inventory.

### Representative Static Resources

| URI                      | Description                        | Returns                                                                                           |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `junban://tasks/pending` | All pending tasks                  | Array of task summaries (id, title, status, priority, dueDate, projectId, tags, estimatedMinutes) |
| `junban://tasks/today`   | Tasks due today (includes overdue) | Array of task summaries                                                                           |
| `junban://projects`      | All non-archived projects          | Array of project objects                                                                          |
| `junban://stats/today`   | Today's productivity stats         | Stats object + currentStreak                                                                      |

### Representative Dynamic Resource Templates

| URI Template                    | Description            | Returns                       |
| ------------------------------- | ---------------------- | ----------------------------- |
| `junban://tasks/{taskId}`       | Single task detail     | Full task object (all fields) |
| `junban://projects/{projectId}` | Project with its tasks | Project object + tasks array  |

---

## Prompts

Prompts are registered in `src/mcp/prompts.ts` and surfaced directly by MCP.

Treat that module as the source of truth for the full prompt inventory.

| Prompt Example | Description                                                                         | Arguments                                          |
| -------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| `plan-my-day`  | Morning planning — reviews today's tasks, overdue items, suggests prioritized order | `energy_level` (optional): "low", "medium", "high" |
| `daily-review` | End-of-day review — summarizes accomplishments and pending work                     | `date` (optional): YYYY-MM-DD, defaults to today   |

---

## Error Handling

Tool execution errors are caught and returned as MCP error content:

| Error Class       | MCP Response                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `NotFoundError`   | `{ isError: true, content: [{ type: "text", text: "Task not found: <id>" }] }`        |
| `ValidationError` | `{ isError: true, content: [{ type: "text", text: "Validation error: <message>" }] }` |
| `StorageError`    | `{ isError: true, content: [{ type: "text", text: "Storage error: <message>" }] }`    |
| Other             | `{ isError: true, content: [{ type: "text", text: "Error: <message>" }] }`            |

---

## Tests

Tests use `InMemoryTransport` from the MCP SDK to create a linked server/client pair without stdio.

| Test File                            | Focus Area                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `tests/mcp/schema-converter.test.ts` | JSON Schema → Zod conversion behavior for supported schema shapes                               |
| `tests/mcp/tools.test.ts`            | Tool registration/execution flow, core task/project operations, and MCP error handling          |
| `tests/mcp/resources.test.ts`        | Static resources and dynamic templates, including empty/populated states and not-found behavior |
| `tests/mcp/prompts.test.ts`          | Prompt registration, argument handling, defaults, and message structure                         |

---

## Key Design Decisions

1. **Zero duplication**: Tools are registered by iterating `ToolRegistry.getDefinitions()` and delegating to `ToolRegistry.execute()`. No tool logic is reimplemented.

2. **Same bootstrap**: The MCP server calls the same `bootstrap()` as the CLI, sharing identical service wiring.

3. **JSON Schema → Zod bridge**: The existing tools define parameters as JSON Schema objects (for LLM providers). The MCP SDK expects Zod shapes. `schema-converter.ts` bridges the gap for the subset of JSON Schema our tools use.

4. **stdio transport**: Standard for local MCP servers. Claude Desktop, the MCP CLI inspector, and custom agents all support stdio.

5. **Console redirection**: MCP stdio requires only JSON-RPC on stdout. All console output is redirected to stderr so logging doesn't corrupt the protocol stream.
