# Developer Guide: MCP

Canonical source: [`../../reference/backend/MCP.md`](../../reference/backend/MCP.md)

This page describes how Junban exposes capabilities through MCP for external AI clients.

## What Junban MCP is

Junban runs a local MCP server over stdio so MCP-compatible clients can use Junban tools, resources, and prompts.

Entry point: `src/mcp/server.ts`

## Why it stays consistent with the app

The MCP server reuses the same application bootstrap and service graph used by other surfaces, instead of reimplementing business logic.

High-level flow:

```text
MCP client -> stdio transport -> src/mcp/* adapters -> core services/tool registry -> storage
```

## Running MCP locally

```bash
pnpm mcp
```

For client integration examples (Claude Desktop and custom SDK clients), use the canonical MCP reference: [`../../reference/backend/MCP.md`](../../reference/backend/MCP.md).

## Contributor guardrails

- MCP protocol traffic uses stdout; avoid incidental stdout logging in MCP server paths.
- Treat AI tool definitions and MCP wiring as mirrored surfaces; avoid hardcoded duplicated inventories.
- Keep error mapping and schema conversion behavior consistent with runtime expectations.

## Related docs

- MCP reference (canonical): [`../../reference/backend/MCP.md`](../../reference/backend/MCP.md)
- AI reference (tool model): [`../../reference/backend/AI.md`](../../reference/backend/AI.md)
- Architecture guide: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)
