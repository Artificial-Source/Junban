# Architecture

Junban is a local-first application with a few intentionally narrow boundaries:

- **Domain core first** (`src/core/`) owns business rules.
- **Storage is abstracted** behind `IStorage` (`src/storage/interface.ts`).
- **Composition happens centrally** (`src/bootstrap.ts` and `src/bootstrap-web.ts`).
- **Interfaces are thin** so UI, API, CLI, MCP, and plugins all act on the same model.

The project is intentionally shaped so different runtimes can share the same domain behavior without rewriting product logic.

## Core idea: one domain, many entry points

The strongest architectural theme is the separation between **domain logic** and **transport/runtime entry points**.

- `src/bootstrap.ts` builds the main Node `AppServices` graph.
- `src/server.ts` and `src/main.ts` call that graph for API/CLI-style execution.
- `src/bootstrap-web.ts` builds a similar graph for browser/Tauri using a web database path.
- `src/mcp/server.ts` reuses the same service graph and exposes it over MCP.

This means task/project behavior is consistent whether a change came from:

- HTTP routes (`src/api/**`),
- React UI (`src/ui/**` direct services or API calls),
- CLI commands (`src/cli/index.ts`), or
- MCP tools (`src/mcp/tools.ts`).

See also: [`../guides/ARCHITECTURE.md`](../guides/ARCHITECTURE.md), [`../reference/backend/CORE.md`](../reference/backend/CORE.md).

## The composition roots as guardrails

The composition roots exist so runtime-specific wiring stays near startup instead of leaking into the domain layer.

In practice, that means storage selection, plugin loading, AI registry setup, and similar cross-cutting concerns are assembled in `src/bootstrap.ts` or `src/bootstrap-web.ts`, while the rest of the app works against services and interfaces.

The durable rule is simple: runtime differences belong at composition time, not spread through `src/core/`.

## Two execution universes, same domain semantics

### Node universe

`src/bootstrap.ts` supports both SQLite and Markdown via `STORAGE_MODE` (default: SQLite).

- CLI/server/plugins/MCP can use the richer filesystem-backed options in Node.
- Markdown mode is possible because Node has file-system access.

### Browser/Tauri universe

`src/bootstrap-web.ts` always uses SQLite because browser mode runs through sql.js and cannot directly depend on markdown file IO.

- This avoids environment-specific conditional logic in core services.
- It also avoids subtle behavior divergence in core rules.

If you are deciding where to implement a feature, ask first: *does it belong in the domain layer or only in transport wiring?* If it is core behavior, prefer putting it in services and keep this boundary intact.

See [`../reference/backend/STORAGE.md`](../reference/backend/STORAGE.md).

## Why this matters: shared invariants

Because multiple entry points call the same services:

- Validation and side effects stay canonical.
- Permission and plugin policy are applied in one place before operations reach domain services.
- MCP/AI tools reuse the same service calls as UI actions.

For example, task creation through an AI tool (`src/ai/tools/**`) and task creation through a route or UI both ultimately flow through `TaskService`. This is the main defense against fragmented behavior.

## Cross-cutting paths and eventing

Junban uses an event bus (`src/core/event-bus.ts`) for reactive side effects such as plugin hooks and follow-up behavior. Persistence itself still happens through the storage layer; the event bus exists so reactions do not have to be hard-coded into every caller.

## Frontend route split (important to understand)

The UI can call backend APIs or use direct service access (`src/ui/api/direct-services.ts`) depending on boot mode. This is a practical architecture choice, not a semantic one:

- Both paths should preserve identical outcomes,
- Direct services optimize local/dev workflows,
- API mode reuses HTTP transport in standalone server-hosted flows.

The architecture docs and this explanation page both treat these as **transport options**, not separate product models.

See [`../reference/frontend/API_LAYER.md`](../reference/frontend/API_LAYER.md) and [`../reference/frontend/CONTEXT.md`](../reference/frontend/CONTEXT.md).

## Tradeoffs and constraints to keep in mind

1. **Single-domain rule vs per-runtime optimization**

   The design optimizes correctness and parity across runtimes by centralizing rules, but it means some runtime-specific fast paths are not implemented directly in domain code.

2. **Multiple storage implementations vs uniform service behavior**

   Supporting Markdown and SQLite increases flexibility but requires a strict storage contract and disciplined feature parity.

3. **Plugin openness vs operational safety**

   Plugin hooks extend behavior, so plugin boundaries are necessary; the cost is additional complexity in permission checks and cleanup.

4. **Web startup size vs feature availability**

   `src/bootstrap-web-ai-runtime.ts` is intentionally lazy to avoid forcing AI/provider code into initial render paths.

5. **Direct service shortcut vs transport coverage**

   Direct service access is convenient for local mode, but behavior must be validated in API/MCP tests as well to avoid skew.

## What must stay true

- Business rules should stay in services, not in transports.
- Runtime-specific concerns should stay near the bootstrap layer.
- Multiple interfaces may exist, but they should not create multiple domain models.

## Conceptual dataflow map

```text
User action
  -> UI/API/MCP/CLI entry point
  -> bootstrap service graph
  -> core services
  -> storage interface
  -> SQLite or Markdown backend
  -> event bus + optional plugin hooks
  -> response / UI refresh / MCP response
```

## Next conceptual reads

- Plugin architecture: [`plugin-system.md`](./plugin-system.md)
- Storage details: [`storage-model.md`](./storage-model.md)
- AI + MCP integration: [`ai-and-mcp.md`](./ai-and-mcp.md)
