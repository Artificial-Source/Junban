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

Phases 1 and 2 implement the hosted product in `junban-domain`, `junban-app`, `junban-storage`, and `junban-server`. The React client consumes only the generated HTTP contract; later surfaces reuse these same application boundaries.

## Crate boundaries

| Crate                | Responsibility                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `junban-domain`      | Pure task entities, UUID IDs, title validation, civil dates and UTC instants                                                 |
| `junban-storage`     | SQLite schema/migrations, profile lock, receipts, activity and durable events                                                |
| `junban-app`         | Framework-free task use cases and application-owned repository/event ports                                                   |
| `junban-server`      | Axum composition, HTTP DTO/OpenAPI authority, principal/scope auth, static serving, SSE, and reusable API-only owner runtime |
| `junban-cli`         | Native CLI session, HTTP executor, versioned automation catalog, and human/JSON commands                                     |
| `junban-mcp`         | Native MCP stdio adapter over the CLI session/catalog (Wave 3 completes tools/resources/prompts)                             |
| `junban-ai`          | Optional provider clients and orchestration                                                                                  |
| `junban-plugin-sdk`  | WIT contract and package types                                                                                               |
| `junban-plugin-host` | Optional Wasmtime runtime after a measured spike                                                                             |

Rules:

- `junban-domain` depends on none of HTTP, SQLite, Tauri, Wasmtime, AI vendors, or frontend tooling.
- HTTP, CLI, MCP, desktop, AI tools, and plugins invoke the same application use cases.
- Avoid a generic “shared” crate. A type belongs to the layer that owns its meaning.
- Transport DTOs are not domain entities.

## Runtime ownership

At any moment, one process owns a profile’s SQLite authority. `fs4` acquires an exclusive profile lock before SQLite opens. The lock remains attached to every repository clone, so it cannot release while a connection is still usable. Private `runtime.json` is a versioned discovery hint (`version`, `address`, `pid`, `instance_id`) and is never authoritative; clients may send a bearer only after an unauthenticated health probe returns the matching `instance_id`. CLI/MCP prefer a verified loopback owner and otherwise start an in-process API-only owner (`LocalApiOwner`) that holds the same lock for exactly their lifetime.

Authenticated requests resolve a principal after Host/origin checks: the operator bearer, or a hashed automation credential with exact scopes `read`, `write`, and/or `data`. Route authorization is centralized and runs before body materialization and maintenance admission. Automation credentials live in private `automation-credentials.json` (not SQLite); operator-only routes cover token rotation, hostname policy, credential admin, restore/recovery mutations, diagnostics, and reminder delivery control-plane.

One long-lived OS thread owns one bundled `rusqlite` connection. Async callers send typed commands over a standard channel and await Tokio one-shot replies; SQLite work never blocks a Tokio executor thread. The connection uses WAL, foreign keys, a 2.5-second busy timeout, `NORMAL` synchronization, and a 250-page (~1 MiB) WAL auto-checkpoint bound (below SQLite's 1000-page default) so commit-path checkpoints stay small. There is no pool.

Schema v2 stores complete tasks plus projects, sections, tags, templates, comments, directed relations and saved filters. A single global revision orders task activity and bounded durable events. Each mutation uses one immediate transaction for its complete effect, canonical-request receipt, activity summary, revision and event; bulk and cascade work is capped at 500 affected tasks. The application publishes only the newly committed event returned by storage. Replayed operations return the original bytes and generated IDs exactly; reusing an operation ID for another canonical request conflicts. Supported task operations carry bounded before/post material for conflict-safe undo.

## HTTP contract and live updates

Transport DTOs live in `junban-server`, not the domain. Utoipa derives the deterministic checked contract at `openapi/junban-v1.json`; `openapi-typescript` generates `src/ui/api/generated.ts`. `pnpm contract:generate` updates both and `pnpm contract:check` regenerates into a temporary directory without mutating the checkout.

SSE clients subscribe before durable catch-up. Revision IDs deduplicate queued/live overlap, and a lagged in-process receiver catches up from SQLite again. Catch-up pages are bounded to 100 events and 2 MiB; retained history is bounded to 2,048 events and 64 MiB, with an explicit resync signal when a client falls behind retained history. This makes SQLite—not the broadcast queue—the live-change authority. Each forwarder selects on client disconnect, process shutdown cancellation, and broadcast work so dropped responses and SIGINT/SIGTERM both release the task promptly. Concurrent SSE connections are hard-capped per process.

Reminder delivery adds one process-global Tokio wake coordinator (started only from `main`, cancelled with the same shutdown token) and an authenticated ephemeral `GET /api/v1/reminders/events` stream. The coordinator sleeps until `next_reminder_wake_at`, broadcasts a content-free `reminders_due` signal with a process-local sequence, and recomputes on `Notify` after committed user mutations and successful reminder control-plane routes. Overdue wakes throttle at 30 seconds unless notified. These wakes are not committed task events and never increment the global revision. They share the same 64-connection SSE cap as `/api/v1/events`.

## Frontend boundary

- `src/` is React/Vite/Tailwind only.
- Node and pnpm build and test the frontend; they are not shipped runtimes.
- The production UI is static assets served by the Rust server (Phase 1+).
- Components should not import backend, storage, or Node APIs.

## Plugin direction

Portable, capability-limited packages on the Wasmtime Component Model with WASI P2. TypeScript authoring compiles ahead of time and does not imply a resident Node plugin process. Declarative host-rendered UI replaces arbitrary plugin React execution.

## Dependency policy

- Prefer the smallest complete dependency set for the current phase.
- `cargo-audit` and `cargo-deny` are mandatory CI checks for the production Rust dependency graph. CI installs pinned prebuilt tool binaries rather than compiling those tools from source on every run.
