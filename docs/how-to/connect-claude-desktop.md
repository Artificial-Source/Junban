# Connect Junban to Claude Desktop (MCP)

This guide shows the quickest reliable path to expose Junban tasks, projects, tags, and stats to Claude Desktop through MCP.

## 1) Add the server to Claude Desktop

Claude Desktop launches the Junban MCP server itself from the config entry below. You do not need to keep a separate `pnpm mcp` terminal running for normal Claude Desktop usage.

Add this block to your `claude_desktop_config.json`:

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

## 2) Restart Claude Desktop

Restart Claude Desktop so it launches the configured MCP process.

## 3) Verify

Once connected, ask Claude to try simple task actions, for example:

- create a task
- list today's tasks
- mark one task complete

These map to the MCP tool/resources/prompts exposed by Junban.

## 4) Optional manual smoke test

If you want to verify that the server starts cleanly outside Claude Desktop, run:

```bash
pnpm mcp
```

The MCP entrypoint in `src/mcp/server.ts` runs on stdio (JSON-RPC). The server uses the same bootstrap services as other entrypoints.

## Useful behavior notes

- The server intentionally uses stdio transport, so stdout must remain JSON-RPC only.
- Console output is redirected to stderr in `src/mcp/server.ts` to avoid protocol noise.
- Plugin-contributed tools are available when plugin loading runs in bootstrap, so MCP sees the same tool registry exposed by Junban.

## Related docs

- Full MCP reference: [`../reference/backend/MCP.md`](../reference/backend/MCP.md)
- CLI and setup context for local profile behavior: [`../guides/SETUP.md`](../guides/SETUP.md)
- Source entrypoint: [`../../src/mcp/server.ts`](../../src/mcp/server.ts)
