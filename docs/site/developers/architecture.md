# Developer Architecture Overview

Canonical source: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)

This page provides the stable mental model for contributors. It is intentionally high-level; use canonical references for subsystem specifics.

## System shape

Junban is local-first and centered on shared core services:

```text
UI/API/CLI/MCP/Plugins -> core services -> storage interface -> SQLite or Markdown
```

Design intent:

- Put business rules in `src/core/`
- Keep transport and UI layers thin
- Reuse services across all interfaces

## Runtime split

### Node runtime

Used by:

- `src/main.ts`
- `src/server.ts`
- `src/cli/index.ts`
- `src/mcp/server.ts`

Composed through `src/bootstrap.ts`.

### Browser inline-backend dev (`pnpm dev`)

Used by:

- `src/ui/main.tsx`
- `vite.config.ts`
- `vite-api-plugin.ts`
- `src/bootstrap.ts`

Composed through `vite-api-plugin.ts`, which lazy-loads `src/bootstrap.ts` into the Vite dev server.

### Browser standalone-backend dev (`pnpm dev:full`)

Used by:

- `src/ui/main.tsx`
- `src/server.ts`
- `src/bootstrap.ts`

Composed through `src/server.ts` (Hono route layer) and `src/bootstrap.ts`.

### Packaged Tauri/webview runtime (direct-services/bootstrap-web mode)

Used by:

- `src/ui/main.tsx`
- `src/bootstrap-web.ts`
- `src/bootstrap-web-ai-runtime.ts`

Composed through `src/bootstrap-web.ts`, with lazy AI runtime loading. This path is the in-process direct-services/webview runtime used by packaged/Tauri webview shells and does not use backend HTTP from UI.

### Tauri shell backend-backed dev mode (`pnpm tauri:dev`)

Used by:

- `src/ui/main.tsx`
- `src/server.ts`

Composed through `src/bootstrap.ts` (backend service graph) + Hono route layer for desktop shell execution. This is the backend-backed Tauri shell development flow (not the packaged direct-services/bootstrap-web runtime).

Important constraints:

- Direct-services mode uses SQLite via `sql.js`.
- Backend-backed modes (Node and Tauri shell) run through Node-capable service composition and support the same bootstrap-backed storage policy.

## Layer responsibilities

- `src/core/`: domain logic and business rules
- `src/storage/`: storage contract and backend implementations
- `src/db/`: SQLite schema, clients, migrations, persistence helpers
- `src/ui/`: React views, components, contexts, hooks, API layer
- `src/api/`: Hono route modules
- `src/ai/`: providers, chat, tools, voice
- `src/plugins/`: plugin runtime, loader, sandbox, permissions
- `src/mcp/`: MCP server adapters and registration
- `src/cli/`: terminal companion commands

## Data flow checkpoints

When reviewing changes, confirm where logic belongs:

- UI behavior issue -> usually `src/ui/**`
- Domain rule change -> `src/core/**` (+ storage/parser/UI/API consumers)
- Persistence change -> `src/storage/**` + `src/db/**`
- Plugin runtime behavior -> `src/plugins/**`
- External agent capability via MCP -> `src/mcp/**` and AI tool/resource/prompt wiring

## Deep references

- Canonical architecture guide: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)
- Frontend references: [`../../reference/frontend/`](../../reference/frontend/)
- Backend references: [`../../reference/backend/`](../../reference/backend/)
- Plugin author/reference docs: [`../../reference/plugins/README.md`](../../reference/plugins/README.md)
