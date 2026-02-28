# MCP Server — Internal Documentation

The MCP (Model Context Protocol) server (`src/mcp/`) exposes Saydo's task management capabilities to external AI agents and apps. Any MCP-compatible client — Claude Desktop, personal assistants, other ASF apps, or custom agents — can manage tasks, projects, tags, and get productivity insights over a local stdio connection.

**Total files:** 7 | **Total lines:** ~300

---

## Architecture Overview

```
External MCP Client (Claude Desktop, custom agent, etc.)
    |
    | JSON-RPC over stdio
    v
src/mcp/server.ts  (entry point)
    |
    ├── registerMcpTools()      → ToolRegistry (all 34 built-in tools)
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

This starts the server on stdio (JSON-RPC). For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "saydo": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/saydo", "mcp"]
    }
  }
}
```

For a custom agent using the MCP SDK:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--dir", "/path/to/saydo", "mcp"],
});

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Create a task
await client.callTool({
  name: "create_task",
  arguments: { title: "Buy groceries", priority: 2 },
});

// Read today's tasks
const today = await client.readResource({ uri: "saydo://tasks/today" });
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
**Purpose:** Registers 6 static resources and 2 dynamic resource templates for read-only data access.
**Key Exports:**
- `registerMcpResources(server, services)` — registers all resources
**Key Dependencies:** `AppServices`, `McpServer`, `ResourceTemplate`

### `prompts.ts`
**Path:** `src/mcp/prompts.ts`
**Purpose:** Registers 3 pre-built prompts for common productivity workflows.
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
**Purpose:** Maps Saydo error classes to MCP error responses with `isError: true`.
**Key Exports:**
- `toMcpError(err)` — returns `{ content: [{ type: "text", text }], isError: true }`

---

## Tools (28 total)

All 34 tools from `ToolRegistry` are exposed as MCP tools with identical names, descriptions, and parameters. See [AI.md](AI.md) for full tool documentation.

| Category | Tools |
|----------|-------|
| Task CRUD | `create_task`, `update_task`, `complete_task`, `delete_task` |
| Task Query | `query_tasks` |
| Project CRUD | `create_project`, `list_projects`, `get_project`, `update_project`, `delete_project` |
| Reminders | `list_reminders`, `set_reminder`, `snooze_reminder`, `dismiss_reminder` |
| Tags | `list_tags`, `add_tags_to_task`, `remove_tags_from_task` |
| Organization | `break_down_task`, `check_duplicates`, `suggest_tags`, `find_similar_tasks` |
| Analytics | `analyze_workload`, `check_overcommitment`, `analyze_completion_patterns`, `get_energy_recommendations`, `get_productivity_stats` |
| Planning | `plan_my_day`, `daily_review` |

---

## Resources (8 total)

### Static Resources

| URI | Description | Returns |
|-----|-------------|---------|
| `saydo://tasks/pending` | All pending tasks | Array of task summaries (id, title, status, priority, dueDate, projectId, tags, estimatedMinutes) |
| `saydo://tasks/today` | Tasks due today (includes overdue) | Array of task summaries |
| `saydo://tasks/overdue` | Overdue tasks (due before today) | Array of task summaries |
| `saydo://projects` | All non-archived projects | Array of project objects |
| `saydo://tags` | All tags | Array of tag objects (id, name, color) |
| `saydo://stats/today` | Today's productivity stats | Stats object + currentStreak |

### Dynamic Resource Templates

| URI Template | Description | Returns |
|--------------|-------------|---------|
| `saydo://tasks/{taskId}` | Single task detail | Full task object (all fields) |
| `saydo://projects/{projectId}` | Project with its tasks | Project object + tasks array |

---

## Prompts (3 total)

| Name | Description | Arguments |
|------|-------------|-----------|
| `plan-my-day` | Morning planning — reviews today's tasks, overdue items, suggests prioritized order | `energy_level` (optional): "low", "medium", "high" |
| `daily-review` | End-of-day review — summarizes accomplishments and pending work | `date` (optional): YYYY-MM-DD, defaults to today |
| `quick-capture` | Fast task creation from natural language | `task` (required): natural language description |

---

## Error Handling

Tool execution errors are caught and returned as MCP error content:

| Error Class | MCP Response |
|-------------|-------------|
| `NotFoundError` | `{ isError: true, content: [{ type: "text", text: "Task not found: <id>" }] }` |
| `ValidationError` | `{ isError: true, content: [{ type: "text", text: "Validation error: <message>" }] }` |
| `StorageError` | `{ isError: true, content: [{ type: "text", text: "Storage error: <message>" }] }` |
| Other | `{ isError: true, content: [{ type: "text", text: "Error: <message>" }] }` |

---

## Tests

Tests use `InMemoryTransport` from the MCP SDK to create a linked server/client pair without stdio.

| Test File | Tests | What's Covered |
|-----------|-------|----------------|
| `tests/mcp/schema-converter.test.ts` | 12 | JSON Schema → Zod: string, number, integer, boolean, array, enum, required/optional, description |
| `tests/mcp/tools.test.ts` | 7 | Tool listing, create/complete/query tasks via MCP, project CRUD, error handling |
| `tests/mcp/resources.test.ts` | 14 | All 6 static resources + 2 templates, empty/populated data, not-found errors |
| `tests/mcp/prompts.test.ts` | 7 | All 3 prompts, argument handling, defaults, well-formed messages |

**Total:** 40 tests

---

## Key Design Decisions

1. **Zero duplication**: Tools are registered by iterating `ToolRegistry.getDefinitions()` and delegating to `ToolRegistry.execute()`. No tool logic is reimplemented.

2. **Same bootstrap**: The MCP server calls the same `bootstrap()` as the CLI, sharing identical service wiring.

3. **JSON Schema → Zod bridge**: The existing tools define parameters as JSON Schema objects (for LLM providers). The MCP SDK expects Zod shapes. `schema-converter.ts` bridges the gap for the subset of JSON Schema our tools use.

4. **stdio transport**: Standard for local MCP servers. Claude Desktop, the MCP CLI inspector, and custom agents all support stdio.

5. **Console redirection**: MCP stdio requires only JSON-RPC on stdout. All console output is redirected to stderr so logging doesn't corrupt the protocol stream.
