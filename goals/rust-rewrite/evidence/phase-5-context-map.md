# Phase 5 Context Map and Contract Plan

Date: 2026-08-01

Base: `0339457` (`feat: add Rust backup and hosted operations`)

Working branch: `phase-5-cli-mcp`

Scope: approved ExecPlan Phase 5 — native CLI, persistent-stdio MCP server, one shared tool catalog, scoped automation credentials, active-owner discovery, no-server ownership, agent skill, conformance, lifecycle, and performance evidence.

## Purpose and observable outcome

A native `junban` command and `junban-mcp` stdio server reach the Phase 1–4 Rust authority without creating a competing SQLite owner. Humans receive concise command output; scripts receive one strict JSON document; MCP hosts receive protocol-only stdout. The same named catalog maps every automation operation to existing application semantics, and a checked agent skill explains when to use one-shot CLI commands versus a persistent MCP session.

The completion bar is observable end to end:

1. a running hosted or desktop owner is discovered and used through authenticated loopback HTTP;
2. with no owner, one CLI or MCP process acquires the existing profile lock and hosts the normal Rust API in-process for exactly its lifetime;
3. concurrent contenders attach to that temporary owner or fail as busy, but never open SQLite concurrently;
4. CLI, MCP, and direct HTTP execute the same deterministic corpus and produce the same normalized state, revisions, events, and errors;
5. scoped automation credentials cannot invoke operator-only recovery or hosted-security operations;
6. stdin EOF and abrupt process termination release listeners, the SQLite worker, and the profile lock;
7. release-binary CLI startup, persistent-operation latency, and MCP idle memory are recorded.

## Baseline and evidence

- Phase 4 is accepted at `0339457`: 389 Rust tests, 345 frontend tests, 91 Playwright scenarios, all supply-chain/documentation/privacy gates, and a clean working tree.
- The one-owner authority is `profile.lock`, held by `ProfileOwner` or `RecoveryOwner` for the lifetime of the SQLite worker.
- `runtime.json` currently contains an address and PID and is removed on graceful shutdown. It is a discovery hint, not authority; an abrupt exit can leave it stale.
- `access-token` is a separate private operator secret. It is not present in runtime metadata or logs.
- The release server reached authenticated health in 94.68 ms median / 141.31 ms maximum in the Phase 1 five-sample baseline. This makes an in-process ephemeral API owner a viable fallback hypothesis, subject to Phase 5 measurement.
- The workspace has four crates. The approved stable shape explicitly assigns Phase 5 to new `junban-cli` and `junban-mcp` crates; no generic shared crate is approved.
- The server publishes 76 OpenAPI paths covering the Phase 1–4 HTTP surface. Core task, catalog, reminder, planning, and timeblocking application semantics already exist in `JunbanService`; hosted policy, diagnostics, maintenance, transfer staging, and recovery remain server-owned.
- The archived implementation is behavioral reference only. Its useful UX patterns are catalog discovery, one-shot CLI versus persistent MCP guidance, exact IDs/date semantics, MCP resources/prompts, and stderr-only diagnostics. Its separate database bootstrap is forbidden.

## Current architecture and dependencies

| Layer              | Current files                                                                       | Phase 5 relationship                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure domain        | `crates/junban-domain/src/**`                                                       | IDs, task/catalog/settings/planning values and parsers remain the validation authority.                                                                                  |
| Application        | `crates/junban-app/src/service.rs`, `ports.rs`, `artifact.rs`                       | All ordinary reads and mutations continue through `JunbanService`; one mutation still means one transaction, receipt, event, and summary.                                |
| Storage owner      | `crates/junban-storage/src/lib.rs`, `worker.rs`                                     | `fs4` exclusive `profile.lock` remains the only ownership decision. No CLI/MCP read-only bypass is allowed.                                                              |
| HTTP/runtime       | `crates/junban-server/src/{lib,main,routes,dto,error,maintenance}.rs`               | Existing API is the single execution backend for remote and no-server operation. Phase 5 extracts a reusable in-process owner runtime and adds credential authorization. |
| Public contract    | `openapi/junban-v1.json`, `src/ui/api/generated.ts`                                 | New credential endpoints and health/runtime fields remain Rust-authored and regenerate both checked artifacts.                                                           |
| Process tests      | `crates/junban-server/tests/process_lifecycle.rs`                                   | Extend for stale metadata, concurrent fallback, EOF/kill, and lock release.                                                                                              |
| Benchmark patterns | `scripts/bench-hosted-server.py`, `goals/rust-rewrite/evidence/phase-*-protocol.md` | Reuse release binaries, bounded health polling, cgroup v2, cleanup verification, binary hashes, and raw JSON evidence.                                                   |
| Documentation      | `docs/{architecture,security,setup,performance}.md`, `docs/README.md`               | Add task-oriented CLI/MCP and credential setup, authority and stdout contracts, evidence links, and troubleshooting.                                                     |

## External protocol decision

Use the official Rust MCP SDK `rmcp` 3.1.x, exact-pinned after the dependency spike, with default features disabled and only the server, stdio/async-I/O transport, and macro/schema features actually required. Its documented MSRV is Rust 1.88, below Junban's pinned Rust 1.93. The official SDK supports the stable 2026-07-28 protocol while retaining 2025-11-25 initialization compatibility.

Phase 5 ships persistent stdio only. Streamable HTTP is deliberately out of scope: the approved outcome requires stdio and only an otherwise approved HTTP transport; no product need currently justifies the version-selection, OAuth, Origin, and extra dependency surface. Junban's existing authenticated HTTP API remains the internal CLI/MCP-to-owner transport, not an MCP HTTP endpoint.

MCP invariants:

- stdin/stdout use one UTF-8 JSON-RPC message per line;
- stdout contains protocol messages only; tracing and process diagnostics use stderr;
- `initialize`/`initialized`, negotiated tools/resources/prompts, pagination, and EOF termination follow the SDK;
- unknown methods or malformed protocol input use JSON-RPC errors;
- domain/authorization/conflict failures return bounded `CallToolResult` data with `isError: true` and stable Junban error fields;
- cancellation drops the active HTTP future or signals the local executor and emits no response after cancellation wins;
- progress is used only for genuinely staged data operations, not ordinary CRUD noise.

Primary references:

- <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>
- <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- <https://modelcontextprotocol.io/specification/2025-11-25/server/resources>
- <https://modelcontextprotocol.io/specification/2025-11-25/server/prompts>
- <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>
- <https://github.com/modelcontextprotocol/rust-sdk>
- <https://docs.rs/rmcp/latest/rmcp/>

## Frozen ownership and discovery design

### Discovery proof

`runtime.json` becomes a strict versioned private record containing `version`, `address`, `pid`, and a random per-process `instance_id`. `/api/v1/health` includes the same `instance_id`. A client may send an operator or automation bearer only after all of these checks pass:

1. parse the runtime record with unknown fields and versions rejected;
2. require its address to be loopback unless the user supplied an explicit `--server` URL;
3. issue a short-timeout unauthenticated health request;
4. require the response instance ID to equal the metadata instance ID.

PID is diagnostic only. It never proves ownership or authorizes deleting a lock/file. The random instance match prevents a stale port from sending Junban credentials to an unrelated process after port reuse.

An explicit `--server` URL is a deliberate authority override, not discovery. CLI and MCP share `--credential-file` / `JUNBAN_CREDENTIAL_FILE`; an explicit target never falls back to the profile operator token. URL userinfo, fragments, and non-HTTPS non-loopback targets are rejected before dialing. Authenticated HTTP clients disable redirects so a bearer is never forwarded to a different authority. Loopback HTTP remains permitted for verified local runtime metadata and temporary owners; non-loopback targets require normal system-root HTTPS validation.

### No-server fallback

Use one production execution backend: authenticated HTTP to the normal Axum routes.

When discovery fails, CLI or MCP starts an API-only owner in-process on `127.0.0.1:0` using a reusable `junban-server` runtime builder. Startup must first acquire `ProfileOwner` (or expose recovery mode honestly), then bind, construct the normal `JunbanService`, maintenance barrier, reminder coordinator, routes, credentials, and runtime metadata, and finally report readiness. It does not serve frontend assets. The caller uses the same HTTP client/catalog as it would against an existing owner.

If owner acquisition returns `AlreadyOwned`, the contender retries discovery with bounded backoff. The winner publishes runtime metadata, allowing concurrent commands to attach. If the lock remains held without a matching reachable runtime after the bound, return a stable `profile_busy` error; never delete the lock, open SQLite, or trust the PID. Runtime shutdown order remains admission close, SSE/reminder drain, listener stop, runtime metadata removal, worker close, lock release.

This rejects both a detached auto-daemon and a separate direct-AppService CLI implementation. It accepts roughly one server startup per no-owner one-shot command because the existing measured baseline is about 95 ms; Phase 5 records the actual release cost and reopens the decision only if evidence shows a material regression.

## Frozen credential and scope design

The existing `access-token` remains the local operator credential. It is the only credential permitted to rotate itself, change hostname policy, restore/recover a profile, manage automation credentials, or clear diagnostics.

Add a private, strict-versioned, atomically replaced `automation-credentials.json` beside the other security artifacts. It stores credential ID, label, creation time, optional expiry, exact scopes, and a one-way hash of a high-entropy secret. The presented token contains a non-secret ID plus secret material so lookup is bounded; secret comparison is constant-time. Unknown versions/fields/scopes fail closed. Raw automation secrets are never stored in SQLite, runtime metadata, diagnostics, argv, or ordinary output.

Issuable scopes are intentionally small:

- `read`: ordinary task, catalog, reminder, planning, timeblock, settings, and sync reads;
- `write`: ordinary task, catalog, reminder, planning/timeblock, settings, and import mutations;
- `data`: task export and complete backup creation.

`write` does not imply `read`; callers request both when needed. Restore, recovery, hostname policy, operator-token rotation, credential administration, and diagnostics clearing are not representable by automation scope. Server route middleware resolves an authenticated principal and each route declares one required scope or operator-only status before body materialization or maintenance admission.

Operator CLI creates/lists/revokes credentials. Creation requires `--write-token <private-path>`; the raw secret is written with owner-only permissions and omitted from human and JSON stdout. CLI and MCP both accept `--credential-file` or `JUNBAN_CREDENTIAL_FILE` and expose no raw-token argument. Automatic operator-token loading is allowed only for an instance-matched local profile owner. Every explicit `--server` requires the shared credential-file contract. The checked skill instructs users to create a `read,write` credential for routine agents and add `data` only when required. The same-user local threat boundary is documented honestly: filesystem access to the operator token remains administrator authority; scopes contain bearer leakage and honest clients, not malicious code running as the profile owner.

## Shared catalog and feature reach

`junban-cli` is a library plus the `junban` binary. Its library owns the active-owner session, HTTP adapter, strict error envelope, command result envelope, and the single versioned automation catalog. `junban-mcp` depends on that library and only translates MCP protocol objects to catalog calls. This dependency is deliberate and avoids an unapproved generic shared crate.

Every catalog entry has a stable name, description, input and output JSON schema, required scope, read/mutation classification, timeout class, and MCP safety annotation. Schemas are generated from or compile-checked against the public Rust DTOs; hand-maintained opaque schema blobs are not accepted. Catalog order and JSON bytes are deterministic. `junban tools list --json`, MCP `tools/list`, and catalog tests consume the same definitions.

The complete catalog covers these existing Phase 1–4 workflows:

| Group               | Required reach                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks               | list/query/get/create/patch, complete/uncomplete/cancel/reopen/delete, move/reorder, bulk operations, and undo receipts.                                   |
| Organization        | projects, sections, tags, templates/application, saved filters, comments, task relations, task detail/activity.                                            |
| Capture/parsing     | natural-language quick entry, filter parsing, text import parsing, and bounded import preview/apply.                                                       |
| Reminders           | list, create-or-reschedule/snooze through `reschedule_reminder`, and dismiss; delivery lease/claim/settle is excluded as control-plane ownership.          |
| Planning/motivation | daily plan, end-of-day review, weekly review, calendar tasks, stats, nudges, Eat the Frog, Task Jar, and Dopamine Menu.                                    |
| Timeblocking        | block and slot list/create/update/delete, move/resize, slot membership, replan preview/apply.                                                              |
| Settings/sync       | typed settings get/update and sync-state reads; settings affect visibility, not authorization.                                                             |
| Data                | JSON/CSV/Markdown export, supported import preview/apply, and complete backup creation. Restore is operator CLI only.                                      |
| Hosted/operator CLI | status, recovery status/restore, hostname policy, token rotation, credential management, diagnostics read/clear. These do not appear in routine MCP tools. |

Human shorthand commands are required for task, project, tag, reminder, planning, data, auth, and server status workflows. Less common catalog operations remain fully reachable through `junban tool call <name> --input <JSON-or-@file>`. Exact legacy command names and output are not preserved.

MCP lists only tools authorized by its credential. Resources are read-only bounded snapshots for profile/sync summary, Today, projects, tags, and typed settings, plus exact-ID task/project resource templates. Prompts are `plan-my-day`, `triage-inbox`, and `weekly-review`; they return instructions/context and never mutate implicitly.

AI inference, provider operations, chat memory, semantic similarity, duration prediction, and AI auto-scheduling remain Phase 6. Plugin-only capability work remains Phase 7.

## Files to create

| File                                                                                   | Purpose                                                                                                              |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `crates/junban-cli/Cargo.toml`                                                         | Native client library and `junban` binary dependencies.                                                              |
| `crates/junban-cli/src/lib.rs`                                                         | Public session/catalog API consumed by MCP.                                                                          |
| `crates/junban-cli/src/{discovery,session,catalog,error,output}.rs`                    | Verified owner discovery, authenticated HTTP calls, catalog metadata/dispatch, stable errors, and output discipline. |
| `crates/junban-cli/src/main.rs` and focused command modules                            | Clap command tree and human/JSON renderers.                                                                          |
| `crates/junban-mcp/Cargo.toml`                                                         | Slim exact-pinned official SDK dependency.                                                                           |
| `crates/junban-mcp/src/{lib,main,tools,resources,prompts}.rs`                          | Persistent stdio adapter and testable handler.                                                                       |
| `crates/junban-cli/tests/**`                                                           | Process, JSON purity, discovery, credential, and human-command tests.                                                |
| `crates/junban-mcp/tests/**`                                                           | Initialization, list/call/read/get, cancellation, EOF, stdout, and termination tests.                                |
| `tests/phase5_conformance/**` or one equivalent Rust harness                           | Same deterministic operation corpus over HTTP, CLI remote/local, and MCP.                                            |
| `.agents/skills/junban/SKILL.md`                                                       | Checked agent workflow and safety guidance.                                                                          |
| `docs/cli.md`, `docs/mcp.md`                                                           | Canonical setup, command, catalog, credential, date/ID, and troubleshooting documentation.                           |
| `scripts/bench-cli-mcp.py`                                                             | Release CLI startup, MCP idle cgroup memory, repeated operation latency, cleanup, and no-Node harness.               |
| `goals/rust-rewrite/evidence/phase-5-automation-benchmark-protocol.md` and result JSON | Frozen workload plus raw accepted evidence.                                                                          |
| `goals/rust-rewrite/evidence/phase-5-review-ledger.md`, `phase-5-outcome.md`           | Stable finding disposition and exact-head closure evidence.                                                          |

## Files to modify

| File                                                                                                                                 | Purpose                        | Planned change                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Cargo.toml`, `Cargo.lock`, `deny.toml`                                                                                              | Workspace/dependency authority | Add the two approved Phase 5 crates and exact/minimal HTTP, MCP, hashing, and schema dependencies; allow only reviewed licenses.    |
| `crates/junban-server/src/main.rs`                                                                                                   | Hosted binary composition      | Delegate reusable startup/shutdown to the library without changing hosted behavior.                                                 |
| `crates/junban-server/src/lib.rs` and focused new modules                                                                            | Owner runtime/auth             | Export default profile resolution, versioned metadata, API-only in-process runtime, principal/scope checking, and credential store. |
| `crates/junban-server/src/routes.rs`, `dto.rs`, `error.rs`                                                                           | Public HTTP contract           | Annotate route scope requirements and add credential management/instance-health DTOs and stable errors.                             |
| `crates/junban-server/src/tests_api.rs`, `tests/process_lifecycle.rs`                                                                | Security/lifecycle regressions | Scope matrix, stale metadata, races, graceful/abrupt cleanup, recovery and maintenance behavior.                                    |
| `openapi/junban-v1.json`, `src/ui/api/generated.ts`                                                                                  | Generated contract artifacts   | Regenerate from Rust after additive HTTP changes. No React behavior change is planned.                                              |
| `scripts/check-runtime-boundary.mjs`, `scripts/check-docs.mjs`, `.github/workflows/ci.yml`, `package.json`                           | Repository gates               | Recognize/build/test two Rust runtime binaries and validate the skill/docs/evidence without introducing Node runtime.               |
| `docs/architecture.md`, `docs/security.md`, `docs/setup.md`, `docs/performance.md`, `docs/README.md`, `README.md`, `CONTRIBUTING.md` | Canonical docs                 | Explain ownership, credentials, CLI/MCP setup/use, performance, and links.                                                          |
| `goals/rust-rewrite/execplan.md`                                                                                                     | Live plan                      | Record Phase 5 decisions, progress, commands, discoveries, evidence, review, outcome, and commit.                                   |

## Reference patterns

| Existing file                                          | Pattern to preserve                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `crates/junban-server/src/main.rs`                     | Clap parsing, default profile path, bind policy, runtime metadata lifetime, and shutdown order.    |
| `crates/junban-storage/src/lib.rs`                     | `ProfileOwner`/`RecoveryOwner` lock acquisition and owner-lifetime guarantee.                      |
| `crates/junban-server/src/routes.rs`                   | Thin HTTP handlers, bounded body admission, `Idempotency-Key`, and typed errors.                   |
| `crates/junban-server/src/dto.rs`                      | Rust-owned public request/response types and OpenAPI derivation.                                   |
| `crates/junban-app/src/service.rs`                     | Application semantics, retries, receipts, revisions, summaries, and events.                        |
| `crates/junban-server/tests/process_lifecycle.rs`      | Spawn/kill/reopen integration style.                                                               |
| `scripts/bench-hosted-server.py`                       | Release-binary/cgroup samples, exact state verification, bounded polling, and fail-closed cleanup. |
| `goals/rust-rewrite/evidence/phase-4-review-ledger.md` | Stable finding IDs and `open`/`fixed`/`rejected`/`deferred` dispositions.                          |

## Implementation phase graph

### Wave 0 — dependency and ownership spike

- Exact-pin the smallest viable `rmcp` feature set and HTTP client configuration in an isolated branch.
- Extract/start the reusable API-only owner and implement versioned instance-matched discovery.
- Prove on release binaries that local-owner startup is viable, stale metadata cannot receive a token, two contenders never both own SQLite, and SDK idle cost is recordable.
- Delete any rejected prototype; freeze one implementation and update this plan.

#### Wave 0 spike result (frozen)

Date: 2026-08-01 · Base: `9a05996` · Branch: `phase-5-cli-mcp`

| Decision         | Frozen choice                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crates           | `crates/junban-cli` (lib + `junban`) and `crates/junban-mcp` (lib + `junban-mcp`); no generic shared crate                                                       |
| MCP SDK          | `rmcp = "=3.1.0"`, `default-features = false`, features `server`, `macros`, `transport-io` only                                                                  |
| HTTP client      | `reqwest 0.12.28`, `default-features = false`, features `json` + `rustls-tls-native-roots`; `redirect::Policy::none()`; no proxy                                 |
| Licenses         | `deny.toml` allows `ISC` and `OpenSSL` for the rustls/ring graph                                                                                                 |
| Runtime metadata | versioned private record `{version:1,address,pid,instance_id}` with `deny_unknown_fields`; `/api/v1/health` returns the same `instance_id`                       |
| Owner fallback   | `junban_server::LocalApiOwner` — `ProfileOwner` first, bind `127.0.0.1:0`, normal `ServerState`/API routes/reminders, metadata after readiness, no static assets |
| Wave 0 surface   | `junban status` / `junban --json status`; MCP temporary `junban_status` tool + `junban://status` resource                                                        |

Initial release measurements on this host (not a frozen budget; Wave 4 records the accepted harness):

| Artifact / sample                                   | Result          |
| --------------------------------------------------- | --------------- |
| `target/release/junban-server`                      | 10.24 MiB       |
| `target/release/junban`                             | 11.87 MiB       |
| `target/release/junban-mcp`                         | 13.44 MiB       |
| no-owner `junban --json status` (5 fresh profiles)  | 169–202 ms wall |
| discovered-owner `junban --json status` (3 samples) | 11–92 ms wall   |
| toolchain                                           | rustc 1.93.0    |

Commands used:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release -p junban-server -p junban-cli -p junban-mcp
cargo deny check
pnpm contract:check
node scripts/check-runtime-boundary.mjs
node scripts/check-docs.mjs
```

Focused regressions cover strict metadata decode, instance-mismatch (no Authorization), stale metadata fallback, explicit URL rejection, redirect rejection without bearer, discovered no second lock, temporary owner release, two-contender safety, CLI JSON stdout purity, and MCP initialize/list/call/resource/EOF plus kill lock release.

### Wave 1 — principal scopes and reusable runtime

#### Wave 1 result (frozen)

Date: 2026-08-01 · Base: `f1a8654` · Branch: `phase-5-cli-mcp`

| Decision        | Frozen choice                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential file | Private strict `automation-credentials.json` beside security artifacts; max **32** credentials; SHA-256 of full bearer; `subtle` CT compare |
| Token format    | `jba_<uuid>_<64-hex>`; client-secret-generated create; response/list never include secret/hash                                              |
| Scopes          | Exact `read`, `write`, `data`; none implies another; unknown scopes/fields/versions fail closed                                             |
| Authorization   | Central `authz::classified_routes` + middleware principal resolution **before** body limit and maintenance                                  |
| Operator-only   | rotate, hosts, credential admin, restore, diagnostics, reminder delivery control plane; unknown routes default operator-only                |
| CLI             | `junban auth create                                                                                                                         | list | revoke`with`--write-token`, global `--json`, explicit credential-file contract |
| Security gate   | `goals/rust-rewrite/evidence/phase-5-review-ledger.md` opened with `P5-SEC-000`                                                             |

- Add strict atomic automation credential persistence and operator-only create/list/revoke routes. **Done.**
- Change auth to resolve a principal and enforce route scopes before request bodies or maintenance. **Done.**
- Preserve operator token/rotation/recovery behavior and add the full denial matrix. **Done.**
- Finish reusable hosted/API-only runtime composition and cross-platform lifecycle tests. **Wave 0 runtime retained; Wave 1 auth integrated.**

### Wave 2 — CLI session, catalog, and commands

#### Wave 2 result (frozen)

Date: 2026-08-01 · Base: `dae4090` · Branch: `phase-5-cli-mcp`

| Decision      | Frozen choice                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog       | Version `1`, **87** tools bound to OpenAPI operation IDs; self-contained input/result schemas from `openapi/junban-v1.json`; excluded health, SSE, reminder delivery control plane, and unsafe raw credential creation |
| Executor      | One `RequestPlan` HTTP backend: method/path/query/JSON/file body, timeout classes, exact operation UUID retry, resumable token rotation, never-auto-retried restore, private atomic downloads, redirects disabled      |
| Generic CLI   | `junban tools list [--scope]` and `junban tool call <name> --input <JSON\|@file> [--output]`                                                                                                                           |
| Ergonomic CLI | `task`, `project`, `tag`, `reminder`, `plan`, `data`, retained `status`/`auth`, operator `server hosts\|rotate-token\|diagnostics\|maintenance\|recovery`                                                              |
| Docs          | Canonical `docs/cli.md` plus setup/architecture/README/execplan links                                                                                                                                                  |

- Implement discovery, HTTP session, idempotency, streaming upload/download, timeout classes, and stable error mapping. **Done.**
- Build the complete typed catalog and generic list/call commands. **Done.**
- Add ergonomic human commands for the named Phase 5 domains and strict JSON mode. **Done.**
- Prove token secrecy, stdout purity, stale/runtime races, and remote/local parity. **Done** via catalog/executor unit tests and CLI process tests on temporary-owner and discovered-owner profiles.
- Close the Wave 2 API-contract audit. **Done after fixes:** `P5-API-001`–`P5-API-011` add actual result schemas, durable token-rotation resumption, secret-safe catalog exclusions, conditional bulk confirmation, truthful side-effect annotations, private crash-durable downloads, strict JSON parser errors, read-only pure POST metadata, restore outcome guidance, and one operator label.

### Wave 3 — MCP, resources, prompts, and skill

- Implement the persistent stdio server over the same session/catalog.
- Add authorized tool filtering, resources/templates, prompts, cancellation, progress where appropriate, and EOF/signal cleanup.
- Add protocol fixtures and real subprocess tests, then write the checked agent skill and MCP setup guide.

### Wave 4 — conformance, performance, docs, and closure

Preparation is frozen in `phase-5-conformance-protocol.md` and `phase-5-automation-benchmark-protocol.md`. A local-owner CLI dry run proved the 17-revision corpus, parser inputs, reminder create-or-reschedule path, recurrence completion/undo, Markdown fingerprint/apply, planning reads, and four stable error cases before harness implementation.

- Run one frozen corpus through direct HTTP, CLI remote, CLI local-owner, and MCP; compare normalized state/revisions/events/errors.
- Run release startup, idle-memory, repeated-operation, abrupt-termination, cleanup, and no-Node evidence.
- Update canonical docs and live plan.
- Pass one API-contract review of the integrated exact-head change; add a security specialist gate only if credential review identifies a distinct severe issue.
- Fix every material finding with focused regression coverage and squash the phase to one commit: `feat: add native CLI and MCP surfaces`.

## Acceptance contract

### Ownership and discovery

- Active local owner use is proven without lock acquisition by the client.
- Runtime records are version/field strict, loopback-default, instance-matched, private, and safe under stale PID/port reuse.
- No-server CLI and MCP acquire the existing exclusive lock before any database open and publish a reachable temporary owner.
- Startup/shutdown races, two fallback contenders, stale metadata, owner-held-without-runtime, recovery markers, SIGTERM, stdin EOF, and abrupt kill cannot produce two owners, corruption, or a retained lock.
- No code deletes a lock or decides ownership from PID liveness.

### Contract and behavior

- Shared catalog definitions are deterministic and schema-valid; CLI and MCP list the same authorized entries.
- Human commands and generic catalog calls cover the complete inventory above.
- CLI `--json` emits exactly one JSON value on stdout for success or failure; non-JSON diagnostics use stderr and exit codes are stable.
- MCP stdout contains only valid protocol frames; initialization, tools, resources, prompts, pagination, cancellation, and EOF pass subprocess tests.
- IDs remain exact strings; civil dates, instants, recurrence/reminder rules, affected-task limits, 2 MiB event pages, 4 MiB receipts, and import/export/backup bounds preserve existing Rust authority.
- Operation IDs are generated once per CLI/MCP mutation and reused across safe retries; exact retries do not republish events.
- Maintenance/restart-required/recovery states surface stable errors rather than reconnect loops or local bypasses.

### Authorization and secrecy

- Operator and each automation scope have an exhaustive route/tool allow/deny test matrix.
- Automation cannot restore/recover, rotate the operator token, change hosts, manage credentials, or clear diagnostics.
- Expired, revoked, malformed, unknown-version, unknown-scope, and hash-mismatched credentials fail closed.
- Raw tokens do not appear in runtime metadata, argv, ordinary stdout/JSON, MCP results, diagnostics, traces, evidence, or repository files.
- CLI/MCP explicit-target authentication uses one private credential-file contract; URL userinfo, fragments, cleartext non-loopback targets, and redirects are rejected before any bearer is sent.
- Creation writes the one-time secret only to the explicitly requested owner-private path; failure does not leave a live credential without its secret or disclose it as fallback.

### Conformance and validation

- HTTP, CLI remote, CLI local-owner, and MCP run the same corpus and produce equivalent normalized task/catalog/reminder/planning/timeblock/settings/data state, revision/event deltas, receipts, and bounded errors.
- Focused tests cover every fixed finding. Broad Rust/frontend/browser checks remain green; no visible React change or screenshot update is expected.
- OpenAPI generation/check and frontend generated-type drift pass.
- Rustfmt, Clippy with denied warnings, all workspace tests, release builds for server/CLI/MCP, cargo audit, cargo deny, npm audit, docs, runtime-boundary, privacy, and diff checks pass.

### Performance evidence

The release harness records, without inventing a legacy target:

- at least 20 active-owner CLI `task list --json` startup/operation samples;
- at least 10 no-owner one-shot CLI startup-to-result samples on fresh deterministic profiles;
- at least three persistent MCP samples with 100 repeated read/write operations, p50/p95 latency, protocol errors, and exact state;
- idle cgroup current/peak and process count for MCP attached to an external owner and MCP hosting a local owner;
- binary hashes/sizes, host/toolchain/commit, SQLite size, lock/listener cleanup, and no resident Node process.

Any client-side idle process over the frozen 24 MiB warm / 32 MiB peak hosted ceilings, any unexplained material hosted-owner regression, duplicate process, cleanup failure, or missing sample blocks acceptance. The final hosted benchmark is rerun if server/auth changes materially alter its resident path.

## Recovery and rollback

- Before the final phase commit, every wave remains squashable to `0339457`; rejected spikes are deleted rather than retained behind features.
- Credential file replacement keeps the prior durable file on write/fsync/rename failure and updates in-memory authority only after persistence succeeds.
- Runtime discovery never repairs or removes owner files. Recovery mode remains server-owned and accepts only operator credentials.
- Interrupted ordinary mutations retain existing transaction/receipt guarantees. Staged transfer artifacts retain Phase 4 permit and cleanup behavior.
- If MCP dependency cost fails the recorded budgets, stop and document the measurement before considering a minimal protocol adapter; do not ship both.
- Rollback of the completed phase is a single revert of the one phase commit; no schema migration is planned because credentials are private security artifacts, not live domain data.

## Review checkpoints

1. This context/contract plan receives an independent planning gate before implementation.
2. Wave 0 records the dependency and ownership decision before the complete catalog is built.
3. After Wave 1 is integrated and testable, one scoped security-review gate covers credential persistence, one-time secret output, authenticated target selection, redirect behavior, principal derivation, and the route allow/deny matrix. Every material finding receives a stable ledger disposition and focused regression before later waves depend on it.
4. The integrated exact-head phase receives the required API-contract reviewer gate for HTTP, CLI, catalog, and MCP compatibility. This is a distinct later public-contract gate, not a duplicate general review. Every material finding is dispositioned and regression-covered before closure.

## Risk assessment

- [x] New public CLI, MCP, tool, credential, and additive HTTP contracts
- [ ] Domain database migration (explicitly not planned)
- [x] Security credential persistence and route authorization
- [x] Cross-platform process and profile-lock races
- [x] Machine stdout/protocol corruption risk
- [x] Large Phase 1–4 catalog drift risk
- [x] Streaming data and maintenance/restart interactions
- [x] New SDK/client dependency and binary/memory cost
- [x] Abrupt cancellation and lock/listener cleanup
- [ ] Visible React design change (out of scope)
- [ ] AI/provider behavior (Phase 6)
- [ ] Plugin capability/runtime behavior (Phase 7)

## Decisions and rejected alternatives

- **Chosen:** two phase-owned crates exactly matching the approved stable shape. **Rejected:** a generic client/shared crate and placing protocol code in the domain.
- **Chosen:** official `rmcp`, minimal exact-pinned stdio features. **Rejected:** hand-rolled MCP unless measured dependency failure reopens the decision.
- **Chosen:** stdio MCP only. **Rejected for this phase:** Streamable HTTP without a demonstrated host/product need.
- **Chosen:** instance-matched loopback discovery plus exclusive-lock fallback; explicit remote authorities require a credential file, HTTPS, no userinfo/fragment, and no redirects. **Rejected:** PID authority, stale-file deletion, cleartext remote auth, and token transmission before identity proof.
- **Chosen:** one HTTP execution backend with an in-process temporary normal server. **Rejected:** detached daemon spawn and a second direct-AppService adapter.
- **Chosen:** private file-backed hashed automation credentials with three non-admin scopes. **Rejected:** storing raw tokens, broad permanent admin tokens, and speculative OS-keyring integration.
- **Chosen:** generic catalog reach plus ergonomic high-frequency commands. **Rejected:** hand-building dozens of one-off human commands as the only route to feature completeness.
- **Chosen:** MCP tool filtering by credential and CLI-only operator recovery/security actions. **Rejected:** exposing restore/token rotation/credential management to routine agents.

## Planning-review ledger

| ID            | Status             | Resolution                                                                                                                                                                                                                            |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P5-PLAN-001` | fixed and approved | The plan now requires a scoped post-Wave-1 security review for the new credential trust boundary and retains the distinct integrated API-contract gate.                                                                               |
| `P5-PLAN-002` | fixed and approved | CLI and MCP now share a non-argv credential-file contract; explicit targets never use the profile operator token, and non-loopback auth requires HTTPS with URL userinfo/fragments and redirects rejected before bearer transmission. |
