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

Phase 0 creates only `crates/junban-domain` so Cargo workspace checks have a real long-lived target. Other crates appear when their owning phase begins.

## Planned crate boundaries

| Crate                | Responsibility                                                       |
| -------------------- | -------------------------------------------------------------------- |
| `junban-domain`      | Pure entities, value objects, validation, recurrence and query rules |
| `junban-storage`     | SQLite schema, migrations, repositories, backup primitives           |
| `junban-app`         | Use cases, transactions, idempotency, events, scheduler-facing ports |
| `junban-server`      | Axum composition, auth, static UI serving, SSE, server binary        |
| `junban-cli`         | Native CLI                                                           |
| `junban-mcp`         | Native MCP adapter                                                   |
| `junban-ai`          | Optional provider clients and orchestration                          |
| `junban-plugin-sdk`  | WIT contract and package types                                       |
| `junban-plugin-host` | Optional Wasmtime runtime after a measured spike                     |

Rules:

- `junban-domain` depends on none of HTTP, SQLite, Tauri, Wasmtime, AI vendors, or frontend tooling.
- HTTP, CLI, MCP, desktop, AI tools, and plugins invoke the same application use cases.
- Avoid a generic “shared” crate. A type belongs to the layer that owns its meaning.
- Transport DTOs are not domain entities.

## Runtime ownership

At any moment, one process owns a profile’s SQLite authority. Hosted server and desktop compositions both use that rule. CLI and MCP discover the active owner rather than silently opening a second database.

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
