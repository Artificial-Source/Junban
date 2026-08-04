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

| Crate                | Responsibility                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `junban-domain`      | Pure task entities, UUID IDs, title validation, civil dates and UTC instants                                                           |
| `junban-storage`     | SQLite schema/migrations, profile lock, receipts, activity and durable events                                                          |
| `junban-app`         | Framework-free task use cases and application-owned repository/event ports                                                             |
| `junban-server`      | Axum composition, HTTP DTO/OpenAPI authority, principal/scope auth, static serving, SSE, and reusable API-only owner runtime           |
| `junban-cli`         | Native CLI session, HTTP executor, versioned automation catalog, and human/JSON commands                                               |
| `junban-mcp`         | Native MCP stdio adapter over the CLI session/catalog (Wave 3 completes tools/resources/prompts)                                       |
| `junban-ai`          | Optional lazy chat/speech provider clients (no default-startup construct)                                                              |
| `junban-plugin-sdk`  | Exact WIT, JBP1/JRI1 trust, manifest/capability/dependency/component-inspection, and private protocol data contracts; no runtime owner |
| `junban-plugin-host` | Accepted future on-demand Wasmtime child runtime; not created by the SDK-first Wave 1 subgate                                          |

Rules:

- `junban-domain` depends on none of HTTP, SQLite, Tauri, Wasmtime, AI vendors, or frontend tooling.
- HTTP, CLI, MCP, desktop, AI tools, and plugins invoke the same application use cases.
- Avoid a generic “shared” crate. A type belongs to the layer that owns its meaning.
- Transport DTOs are not domain entities.
- AI chat tools mutate only through `junban-app`; raw provider API keys live outside SQLite in profile-private `ai-secrets.json`.
- Browser-local speech (Whisper/Kokoro/Piper/VAD) runs in the page with pinned manifests and same-origin workers; it is not a server subsystem. Operator guide: [`ai-and-voice.md`](ai-and-voice.md).

## Runtime ownership

At any moment, one process owns a profile’s SQLite authority. `fs4` acquires an exclusive profile lock before SQLite opens. The lock remains attached to every repository clone, so it cannot release while a connection is still usable. Private `runtime.json` is a versioned discovery hint (`version`, `address`, `pid`, `instance_id`) and is never authoritative; clients may send a bearer only after an unauthenticated health probe returns the matching `instance_id`. CLI/MCP prefer a verified loopback owner and otherwise start an in-process API-only owner (`LocalApiOwner`) that holds the same lock for exactly their lifetime.

Authenticated requests resolve a principal after Host/origin checks: the operator bearer, or a hashed automation credential with exact scopes `read`, `write`, and/or `data`. Route authorization is centralized and runs before body materialization and maintenance admission. Automation credentials live in private `automation-credentials.json` (not SQLite); operator-only routes cover token rotation, hostname policy, credential admin, restore/recovery mutations, diagnostics, and reminder delivery control-plane.

One long-lived OS thread owns one bundled `rusqlite` connection. Async callers send typed commands over a standard channel and await Tokio one-shot replies; SQLite work never blocks a Tokio executor thread. The connection uses WAL, foreign keys, a 2.5-second busy timeout, `NORMAL` synchronization, and a 250-page (~1 MiB) WAL auto-checkpoint bound (below SQLite's 1000-page default) so commit-path checkpoints stay small. There is no pool.

Schema v2 stores complete tasks plus projects, sections, tags, templates, comments, directed relations and saved filters. A single global revision orders task activity and bounded durable events. Each mutation uses one immediate transaction for its complete effect, canonical-request receipt, activity summary, revision and event; bulk and cascade work is capped at 500 affected tasks. The application publishes only the newly committed event returned by storage. Replayed operations return the original bytes and generated IDs exactly; reusing an operation ID for another canonical request conflicts. Supported task operations carry bounded before/post material for conflict-safe undo.

## HTTP contract and live updates

Transport DTOs live in `junban-server`, not the domain. Utoipa derives the deterministic checked contract at `openapi/junban-v1.json`; `openapi-typescript` generates `src/ui/api/generated.ts`. `pnpm contract:generate` updates both and `pnpm contract:check` regenerates into a temporary directory without mutating the checkout.

SSE clients subscribe before durable catch-up. Revision IDs deduplicate queued/live overlap, and a lagged in-process receiver catches up from SQLite again. Catch-up pages are bounded to 100 events and 2 MiB; retained history is bounded to 2,048 events and 64 MiB, with an explicit resync signal when a client falls behind retained history. This makes SQLite—not the broadcast queue—the live-change authority. Each forwarder selects on client disconnect, process shutdown cancellation, and broadcast work so dropped responses and SIGINT/SIGTERM both release the task promptly. Concurrent SSE connections are hard-capped per process.

Reminder delivery adds one process-global Tokio wake coordinator (started only from `main`, cancelled with the same shutdown token) and an authenticated ephemeral `GET /api/v1/reminders/events` stream. The coordinator sleeps until `next_reminder_wake_at`, broadcasts a content-free `reminders_due` signal with a process-local sequence, and recomputes on `Notify` after committed user mutations and successful reminder control-plane routes. Overdue wakes throttle at 30 seconds unless notified. These wakes are not committed task events and never increment the global revision. They share the same 64-connection SSE cap as `/api/v1/events`.

## Durable AI response authority

AI chat uses ordinary schema-v6 session/message/run rows. Daily briefing durably reserves only one assistant streaming message carrying the server-local `briefing_date`; a partial unique expression index permits at most one streaming/completed briefing for a profile date while failed/cancelled attempts remain history. Provider context adds one ephemeral server-owned user instruction with the exact date, read-only `plan_my_day`-first/no-apply language, and confirmed default energy when configured. No scheduler table or durable synthetic user message is involved.

Edit, retry, and regenerate are typed suffix rewrites. Basic chat and typed actions share the same provider/configuration/context/credential preflight under the AI reconfiguration admission mutex before one storage transaction preserves the exact prefix, rejects an active suffix, tombstones removed run IDs for the 30-day receipt horizon, deletes the suffix, appends one completed user plus streaming assistant/run seed, and recomputes quotas. Invalidation session IDs are historical metadata independent of live session deletion and expire only with their receipt horizon. The setup task owns the response sender, SSE permit, mutex, request, and runtime admission through commit, so a dropped handler still terminalizes its durable run without cancelling unrelated runs. Exact terminal retries replay the retained seed and SSE transcript without provider setup or egress.

Mutation tools require an approval bound to canonical tool name and arguments before `AppService` dispatch; streaming uses versioned local SSE envelopes rather than vendor frames. The response-action and chat routes are operator-only HTTP/SSE and intentionally do not extend the frozen CLI/MCP catalog. Configuration, credentials, tools, local voice, and operator troubleshooting: [`ai-and-voice.md`](ai-and-voice.md).

## Frontend boundary

- `src/` is React/Vite/Tailwind only.
- Node and pnpm build and test the frontend; they are not shipped runtimes.
- The production UI is static assets served by the Rust server (Phase 1+).
- Components should not import backend, storage, or Node APIs.

## Plugin direction

Portable, capability-limited packages use the checked-in `junban:plugin@0.1.0` Component Model WIT. `junban-plugin-sdk` owns bounded JBP1 package parsing/packing, strict Ed25519 verification, canonical typed manifests, requested/granted permission hashes and subset authority, dependency/lock validation, JRI1 verification, bounded structural component inspection, capability metadata, and private parent/child protocol DTOs. It owns no SQLite, HTTP server, Wasmtime Engine, host process, profile path, or credential.

The accepted runtime placement remains an on-demand `junban-plugin-host` child, but that product host is a later wave and does not yet exist. Default `junban-server` links the SDK through one zero-allocation static marker/table so thin LTO preserves the boundary; `--no-default-features` is the matched feature-off baseline. Neither build links Wasmtime. The completed Wave 0 probe crate and its Wasmtime advisory exception were removed after the placement ADR was accepted.

TypeScript authoring compiles ahead of time and does not imply a resident Node plugin process. Declarative host-rendered UI replaces arbitrary plugin React execution. Schema v7, package publication, runtime, routes, registry artifacts, reference plugins, and UI remain outside this SDK-first subgate.

## Dependency policy

- Prefer the smallest complete dependency set for the current phase.
- `cargo-audit` and `cargo-deny` are mandatory CI checks for the production Rust dependency graph. CI installs pinned prebuilt tool binaries rather than compiling those tools from source on every run.
