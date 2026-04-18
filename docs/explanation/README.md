# Explanation

Explanation pages focus on understanding. They describe how Junban is put together, why key boundaries exist, and which tradeoffs are visible in the current repository.

## Concepts

| Topic | Page |
| --- | --- |
| Shared core and runtime entrypoints | [`architecture.md`](architecture.md) |
| SQLite and Markdown storage tradeoffs | [`storage-model.md`](./storage-model.md) |
| Plugin loader, permissions, and sandbox boundaries | [`plugin-system.md`](./plugin-system.md) |
| AI providers, built-in tools, and MCP | [`ai-and-mcp.md`](./ai-and-mcp.md) |

## Source Grounding

These pages are grounded in source files such as `src/bootstrap.ts`, `src/bootstrap-web.ts`, `src/storage/interface.ts`, `src/plugins/`, `src/ai/`, `src/mcp/server.ts`, and the existing architectural docs under [`../guides/ARCHITECTURE.md`](../guides/ARCHITECTURE.md).

## See Also

- Tutorials: [`../tutorials/README.md`](../tutorials/README.md)
- How-to guides: [`../how-to/README.md`](../how-to/README.md)
- Technical reference: [`../reference/README.md`](../reference/README.md)
