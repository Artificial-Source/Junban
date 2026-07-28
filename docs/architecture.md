# Architecture

This document records the stable architecture boundaries for the Junban Rust rewrite. Implementation detail is added by the phase that owns each boundary. The live plan is [`../goals/rust-rewrite/execplan.md`](../goals/rust-rewrite/execplan.md).

## Goals

- Preserve the approved React interface while replacing the shipped runtime with Rust.
- Deliver Tailnet/web first; desktop, CLI, and MCP share the same application core.
- Keep optional AI, voice, and plugins off the default startup path when unused.

## Repository layout

```text
crates/           Rust workspace crates (created when their phase starts)
src/              React frontend only
src-tauri/        Thin desktop shell (later phase)
tests/            Cross-surface acceptance coverage
docs/             Canonical documentation
goals/            Live plans and evidence
```

Phase 1 implements the backend/contract boundary in `junban-domain`, `junban-app`, `junban-storage`, and `junban-server`. UI integration remains a dependent Phase 1 wave.

## Crate boundaries

| Crate                | Responsibility                                                                |
| -------------------- | ----------------------------------------------------------------------------- |
| `junban-domain`      | Pure task entities, UUID IDs, title validation, civil dates and UTC instants  |
| `junban-storage`     | SQLite schema/migrations, profile lock, receipts, activity and durable events |
| `junban-app`         | Framework-free task use cases and application-owned repository/event ports    |
| `junban-server`      | Axum composition, HTTP DTO/OpenAPI authority, auth, static serving and SSE    |
| `junban-cli`         | Native CLI                                                                    |
| `junban-mcp`         | Native MCP adapter                                                            |
| `junban-ai`          | Optional provider clients and orchestration                                   |
| `junban-plugin-sdk`  | WIT contract and package types                                                |
| `junban-plugin-host` | Optional Wasmtime runtime after a measured spike                              |

Rules:

- `junban-domain` depends on none of HTTP, SQLite, Tauri, Wasmtime, AI vendors, or frontend tooling.
- HTTP, CLI, MCP, desktop, AI tools, and plugins invoke the same application use cases.
- Avoid a generic “shared” crate. A type belongs to the layer that owns its meaning.
- Transport DTOs are not domain entities.

## Runtime ownership

At any moment, one process owns a profile’s SQLite authority. `fs4` acquires an exclusive profile lock before SQLite opens. The lock remains attached to every repository clone, so it cannot release while a connection is still usable.

One long-lived OS thread owns one bundled `rusqlite` connection. Async callers send typed commands over a standard channel and await Tokio one-shot replies; SQLite work never blocks a Tokio executor thread. The connection uses WAL, foreign keys, a 2.5-second busy timeout and `NORMAL` synchronization. There is no pool.

Schema v1 stores tasks, the global revision, operation receipts, activity and durable events. Each mutation uses one immediate transaction for the task effect, exact canonical-request receipt, activity row, revision and event. The application publishes only the committed event returned by storage. Replayed operations return the stored response exactly; reusing an operation ID for another canonical request conflicts.

## HTTP contract and live updates

Transport DTOs live in `junban-server`, not the domain. Utoipa derives the deterministic checked contract at `openapi/junban-v1.json`; `openapi-typescript` generates `src/ui/api/generated.ts`. `pnpm contract:generate` updates both and `pnpm contract:check` regenerates into a temporary directory without mutating the checkout.

SSE clients subscribe before durable catch-up. Revision IDs deduplicate queued/live overlap, and a lagged in-process receiver catches up from SQLite again. This makes SQLite—not the broadcast queue—the live-change authority.

## Frontend boundary

- `src/` is React/Vite/Tailwind only.
- Node and pnpm build and test the frontend; they are not shipped runtimes.
- The production UI is static assets served by the Rust server (Phase 1+).
- Components should not import backend, storage, or Node APIs.

## Plugin direction

Portable, capability-limited packages on the Wasmtime Component Model with WASI P2. TypeScript authoring compiles ahead of time and does not imply a resident Node plugin process. Declarative host-rendered UI replaces arbitrary plugin React execution.

## Dependency policy

- Prefer the smallest complete dependency set for the current phase.
- `cargo-audit` and `cargo-deny` become mandatory in CI when production Rust dependencies arrive (Phase 1). Phase 0 has an empty Rust dependency graph and does not compile audit tooling in CI.
