# Phase 7 context map and execution contract

Date: 2026-08-04
Status: high-risk planning gate approved on 2026-08-04; Wave 0 implementation authorized
Base: Phase 6 commit `18bea1b899108f218074714697759af02fa56670`

## Purpose and observable outcome

Phase 7 lets an operator install, inspect, permission, enable, use, disable, and remove portable WebAssembly Component Model plugins authored in Rust or TypeScript. Plugins may contribute commands, events, isolated settings/KV state, bounded HTTP calls, and declarative panels/views/status/actions rendered only by trusted Junban React components.

The delivered runtime remains local-first and capability-limited:

- no enabled plugin means no Wasmtime engine or plugin-host process exists;
- Node is author/build tooling only and is never launched by Junban;
- a plugin cannot load native code, arbitrary React/JavaScript, raw sockets, raw filesystem paths, processes, environment variables, or Junban's database;
- all task/project/tag effects use the same Rust application service, bounds, receipts, transactions, events, and conflict rules as first-party surfaces;
- traps, resource exhaustion, malformed output, host-process failure, and dependency failure cannot stop the server or corrupt task state;
- package bytes, manifest, signer, permissions, dependency lock, and runtime generation are exact, inspectable authorities rather than suggestions.

The phase ends only after the frozen Rust and TypeScript examples build and run on Linux, macOS, and Windows; separate default/Rust/TypeScript optimized evidence passes; the preserved Extensions interface and declarative contributions pass visual/accessibility acceptance; hostile plugins pass; all named findings are closed; and the entire phase is one clean commit `feat: add portable Wasm plugins`.

## Baseline and verified evidence

### Current repository

- Workspace crates: `junban-domain`, `junban-app`, `junban-storage`, `junban-server`, `junban-cli`, `junban-mcp`, and lazy `junban-ai`.
- `crates/junban-plugin-sdk` and `crates/junban-plugin-host` do not exist.
- SQLite schema head is v6; schema v7 is unused and available.
- `FeatureSettings` contains only six first-party feature toggles. `/settings/plugins` is intentionally rejected today, and `FeaturesTab` documents that plugin keys are unsupported.
- `docs/architecture.md` reserves `junban-plugin-sdk` for WIT/package contracts and `junban-plugin-host` for the measured optional runtime.
- `docs/performance.md` requires no Wasmtime initialization on ordinary startup.
- The CLI/MCP catalog remains the frozen independent 87 tools. Plugin administration and contributed commands do not silently expand it.
- Phase 6 final hosted evidence is the immediate default-path baseline: 8.3711 MiB median / 8.8477 MiB maximum warm and 8.9727 MiB peak for the matched disabled workload, below the frozen 24/32 MiB ceilings.

### Current upstream checkpoint

Verified on 2026-08-04:

- Wasmtime/`wasmtime-wasi` **45.0.3** are the newest patch line compatible with Junban's Rust 1.93.0 pin. Wasmtime 46/47 require Rust 1.94. Phase 7 pins exact 45.0.3 and re-evaluates only through a separate toolchain decision.
- Product runtime uses Component Model + WASI Preview 2. WASI Preview 3 and component-model async guest ABI are experimental/out of scope.
- Host limits use `StoreLimits`, on-demand allocation unless the spike proves otherwise, epoch interruption plus host-future cancellation, one mutable store owner, bounded buffers, and a deny-by-default/selective linker.
- Rust guests use stable `wasm32-wasip2` plus `wit-bindgen`; `cargo-component` is being deprecated and is not the authoring authority.
- TypeScript uses exact build-only `@bytecodealliance/jco` 1.26.1 and `@bytecodealliance/componentize-js` 0.22.0. A component embeds StarlingMonkey and is expected to add roughly 8 MiB or more before guest heap; its package/memory/cold-start evidence remains separate.
- Package signatures use strict Ed25519 verification (`ed25519-dalek` 2.2.0) and existing SHA-256. Full TUF, Sigstore, Warg, OCI registry clients, Minisign as a runtime ABI, Extism, WASI P3, and resident Node are excluded from v1.

Primary upstream sources are retained in [`plugin-runtime-research.md`](plugin-runtime-research.md) and include:

- <https://docs.wasmtime.dev/api/wasmtime/component/index.html>
- <https://docs.rs/wasmtime/45.0.3/wasmtime/>
- <https://docs.rs/wasmtime-wasi/45.0.3/wasmtime_wasi/>
- <https://component-model.bytecodealliance.org/language-support/building-a-simple-component/rust.html>
- <https://component-model.bytecodealliance.org/language-support/building-a-simple-component/javascript.html>
- <https://bytecodealliance.github.io/jco/>
- <https://github.com/bytecodealliance/ComponentizeJS>
- <https://docs.rs/ed25519-dalek/2.2.0/ed25519_dalek/>
- <https://www.rfc-editor.org/rfc/rfc8785>

### Legacy behavioral and visual authority

The archived read-only repository at commit `5e2b2b5adc865f401843c5030285293c5fabccc5` provides behavioral/visual reference only.

Preserved product behavior:

- Settings tab id `plugins`, visible label **Extensions**;
- Built-in Extensions list, enable/disable, Restricted Mode/community safety confirmation, permission approval/revocation, registry browse/search/filter/detail/install/uninstall, plugin settings, loading/empty/error/retry states;
- contributed commands, navigation/tools/workspace views, sidebar panels, status items, events, isolated storage, and typed settings;
- Pomodoro as a real user-facing reference plugin.

Deliberately rejected legacy architecture:

- Node `vm`, `require`, archive extraction, unrestricted host filesystem/process access;
- dynamic TypeScript/React imports and `contentType: "react"`;
- “restricted mode” presented as hostile-code isolation;
- package code staged under the application source tree or resolved through `node_modules`.

Wave 0 captures independent immutable legacy-rendered Extensions authorities before visible implementation. At minimum they cover desktop/mobile Extensions management, Restricted Mode, permission review, registry list/detail/error/empty states, typed settings, Pomodoro view/status, and a declarative panel/action. Existing first-party Calendar, Matrix, Stats, Timeblocking, Someday, Completed, Cancelled, and Quick Wins remain first-party Phase 2/3 surfaces rather than being rewrapped as plugins.

## Scope

### In scope

- versioned `junban:plugin@0.1.0` WIT world and Rust SDK;
- exact package framing, canonical manifest, Ed25519 signature, SHA-256 identity, publisher trust, compatibility, dependency graph, and atomic content-addressed store;
- schema-v7 installed state, grants, isolated settings/KV, event cursor, lifecycle/error state, publisher trust, and bounded registry metadata;
- measured lazy-in-process versus on-demand child-host spike and one retained placement;
- Wasmtime Component Model/WASI P2 host with strict capabilities and limits;
- deterministic dependency-first activation and bounded dependency service calls;
- operator-only plugin/registry/permission/settings/view/command/action HTTP APIs;
- durable live-event delivery with deterministic action identities and circuit breaking;
- trusted declarative React renderer and preserved Extensions UX;
- bundled signed static registry with Rust Pomodoro and automation references plus a real TypeScript import reference;
- cross-platform SDK/template builds, hostile components, dogfood, performance evidence, docs, and review.

### Out of scope

- native dynamic libraries, unrestricted in-process Rust/C/C++ plugins, arbitrary guest React/DOM/CSS/HTML/JavaScript, Node/Deno/JVM/Python plugin processes;
- direct SQLite, operator bearer, automation credential, AI/provider secret, environment, process, raw filesystem, raw socket, or unrestricted WASI HTTP access;
- custom remote registries, transparency logs, full TUF/Sigstore/OCI/Warg clients, background auto-update, or a live marketplace service;
- WASI Preview 3, component-model async guest ABI, Extism/Javy/AssemblyScript as a second public contract, or `cargo-component` as the documented Rust path;
- plugin-contributed AI provider/tool contracts, CLI/MCP catalog expansion, desktop-only integration, updater integration, or legacy plugin compatibility;
- hiding TypeScript's component/runtime cost inside default or Rust-plugin evidence.

## Context map

### Files and crates to create

| Path                                    | Purpose                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crates/junban-plugin-sdk/`             | WIT package, typed manifest/package/index/signature/dependency/UI/capability contracts, guest helper API, fixed JBP1 framing, golden vectors, and private parent↔host protocol types without Wasmtime construction |
| `crates/junban-plugin-host/`            | Optional Wasmtime host binary/runtime, selective linker, store/invocation limits, IPC driver, component lifecycle, capability bridge, dependency service calls, and hostile tests                                  |
| `plugins/reference/pomodoro-rust/`      | Rust reference proving command, settings, KV, timer/status/view, and declarative actions                                                                                                                           |
| `plugins/reference/automation-rust/`    | Rust reference proving event subscription, deterministic mutation request, receipt replay, and loop circuit breaker                                                                                                |
| `plugins/reference/import-typescript/`  | Real TypeScript build-only template/reference proving componentization and bounded bulk-create action                                                                                                              |
| `plugins/registry/`                     | Bundled signed static index and content-addressed immutable reference packages; no private signing key                                                                                                             |
| `src/ui/plugins/`                       | Lazy plugin transport/state, Extensions UI, registry/permission/settings surfaces, declarative renderer, contribution slots, and tests                                                                             |
| `docs/plugins.md`                       | Operator security, install/lifecycle, permissions, registry, failure, backup/restore, and troubleshooting guide                                                                                                    |
| `docs/plugin-authoring.md`              | WIT/SDK, Rust/TypeScript builds, manifest/signing/packing, limits, UI/actions, examples, and no-runtime-Node contract                                                                                              |
| `goals/rust-rewrite/evidence/phase-7-*` | ADR/spike, visual authority, benchmark protocol/results, dogfood, hostile/cross-platform evidence, review ledger, and outcome                                                                                      |

### Files likely to modify

| Path                                                                                    | Relationship / expected change                                                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cargo.toml`, `Cargo.lock`, `deny.toml`                                                 | Add exact minimal Component Model, WASI P2, Ed25519, semver, and WIT dependencies/features/licenses                                               |
| `crates/junban-domain/src/lib.rs` and a focused plugin module                           | Typed plugin IDs, states, capabilities, grants, settings/UI/action bounds; no Wasmtime/HTTP/SQLite                                                |
| `crates/junban-app/src/{ports,requests,service,event}.rs`                               | Plugin repository port, lifecycle operations, deterministic effect dispatch through existing use cases, plugin resource events; no runtime engine |
| `crates/junban-storage/src/{migration,backup_ops,lib}.rs` plus focused plugin ops/tests | Schema v7, validation, receipts, dependency/grant/state/KV/cursor storage, restore sanitization, package reconciliation metadata                  |
| `crates/junban-server/src/lib.rs` plus focused plugin modules/routes                    | Operator APIs, staged package admission, bundled registry, lazy supervisor, child lifecycle/drain/restart, capabilities, event worker, OpenAPI    |
| `crates/junban-server/tests/process_lifecycle.rs`                                       | Schema-v7 and child-host lock/shutdown/crash/no-orphan acceptance                                                                                 |
| `openapi/junban-v1.json`, `src/ui/api/generated.ts`                                     | Generated plugin operator contract; automation catalog remains 87                                                                                 |
| `src/ui/views/settings/{settingsHelpers,SettingsDialog}.tsx`                            | Add lazy **Extensions** tab with preserved desktop/mobile behavior                                                                                |
| `src/ui/components/Sidebar.tsx`, command palette and app layout integration             | Host-rendered plugin views/panels/status/commands only after contributions are server-confirmed                                                   |
| `scripts/check-runtime-boundary.mjs`, `package.json`, `.github/workflows/ci.yml`        | Ban runtime Node/native plugin paths; exact host/example/hostile/cross-platform build gates                                                       |
| `docs/{README,architecture,security,performance,setup}.md`, `CONTRIBUTING.md`           | Canonical plugin boundaries, author workflow, threat model, commands, and evidence                                                                |
| `goals/rust-rewrite/execplan.md`                                                        | Live Wave 0–5 progress, decisions, findings, metrics, and retrospective                                                                           |

### Reference patterns

| Pattern                                                                  | Authority to reuse                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| One application mutation / transaction / event / receipt                 | `junban-app` services and `junban-storage` worker commands                    |
| Exact canonical receipt replay and deterministic child operation IDs     | Phase 2 mutations and Phase 6 approval/tool dispatch                          |
| Lazy optional runtime, cancellation, drain, reconfigure, restore fencing | `AiRuntimeSupervisor`, `SpeechRuntimeSupervisor`, restore admission           |
| Private atomic staging/content hash                                      | backup/restore/export staging and local voice manifest cache                  |
| Typed strict settings and generated DTO/OpenAPI/TS                       | Phase 4 settings and Phase 6 operator routes                                  |
| Durable event catch-up                                                   | global retained events; plugin cursors consume by revision with bounded pages |
| Accessible Settings modal/confirmations                                  | `SettingsDialog`, `DataTab`, settings helpers/components                      |
| Query-scoped visual fixture without runtime design changes               | Phase 2/3/6 immutable visual harnesses                                        |
| Release cgroup/process evidence                                          | Phase 6 disabled and enabled benchmark harnesses                              |

## Architecture and ownership

### Dependency direction

The intended stable direction is:

```text
junban-domain <- junban-app <- junban-storage
       ^               ^             ^
       |               |             |
junban-plugin-sdk      +------ junban-server ----spawn----> junban-plugin-host
       ^                              |
       +------------------------------+
```

- `junban-plugin-sdk` contains portable WIT/package/data contracts only. It constructs no Wasmtime engine and contains no server/database owner.
- `junban-plugin-host` owns Wasmtime and guest stores only. It never opens SQLite, reads the profile token, or calls Junban HTTP.
- `junban-server` remains the sole profile/application authority. It verifies packages and grants, owns the event cursor, mediates every capability, and spawns the host only after an enabled graph exists.
- Host placement is finalized by the Wave 0 spike. If lazy in-process wins every frozen criterion, the same ownership and no-engine-when-unused rules apply. Temporary losing spike code is deleted.

A separate small generic “shared” crate is not added. Parent/child protocol types belong in the plugin SDK because both product sides need the versioned plugin-host contract and it carries no engine.

### Host-placement spike and decision rule

Wave 0 builds throwaway, isolated probes for:

1. Phase 6 baseline server;
2. Phase 7 server linked to SDK/protocol only, no engine;
3. server linked to a lazy in-process Wasmtime path before and after `Engine` creation;
4. server plus on-demand `junban-plugin-host`, before child spawn, child idle, Rust component active, and TypeScript component active;
5. trap, CPU loop, memory growth, child kill, disable, and server shutdown behavior.

Five optimized samples record server/child cgroup current+peak, RSS/PSS/process tree, binary sizes, startup-to-health, package verify/compile/instantiate/first-call/warm-call/disable latency, and cleanup. The retained choice must:

- leave ordinary no-plugin server within 24 MiB warm / 32 MiB peak and within `max(15%, 1 MiB)` median growth versus Phase 6;
- construct no Engine and spawn no host without an enabled plugin;
- keep a guest trap/CPU/memory violation from stopping the server;
- terminate/recover bounded work and release the host on last disable/shutdown;
- avoid an IPC or lifecycle framework larger than the demonstrated boundary;
- freeze numeric active Rust/TypeScript memory/cold/warm limits before Wave 1.

Fault containment breaks a close measurement tie in favor of the child process. The ADR records the losing result and all temporary spike scaffolding is removed.

### WIT world v0.1.0

Package authority: `package junban:plugin@0.1.0` with one synchronous guest world. Host implementations may await bounded Rust work internally; WASI P3/native async guest contracts are excluded.

Guest exports:

- lifecycle `activate` / `deactivate`;
- `invoke-command`;
- `handle-event`;
- `render-surface` and `handle-surface-action`;
- `validate-settings`;
- bounded read-only `call-service` for declared plugin dependencies.

Host imports:

- read-only bounded task/project/tag queries;
- isolated plugin settings and KV reads;
- bounded monotonic/wall clock;
- one synchronous permission-scoped exact-origin HTTP request interface;
- bounded structured logging;
- bounded call to a declared active dependency's read-only service export.

Guest calls never commit domain or plugin-state writes. A successful ordinary export returns one typed `plugin-outcome` containing:

- at most one application mutation request (single or existing bounded bulk operation), **or** one isolated settings/KV patch;
- declarative result/surface material;
- bounded logs.

There are no deferred HTTP intents in `plugin-outcome`. HTTP exists only as a synchronous host import so the guest can inspect the bounded response. The host records whether an invocation used HTTP and rejects any mutation or plugin-state patch returned by that invocation; an invocation is either externally effecting through HTTP or eligible for one post-success SQLite effect, never both.

The parent validates and commits the one SQLite effect only after the guest returns successfully. Trap, timeout, malformed output, cancellation, or oversized material therefore commits no task/plugin-state mutation. Existing AppService mutations remain the semantic authority; the WIT world does not duplicate domain rules.

Every HTTP-capable command, UI action, event hook, or direct service invocation is honestly **at-least-once** externally. It carries a stable `x-junban-plugin-delivery-id` derived from the operator operation id or event revision; redirects are forbidden. Completed invocation receipts prevent an exact retry after durable terminalization, but a crash after a remote accepted a request and before Junban durably terminalizes may repeat the same delivery id. No atomicity between remote HTTP and SQLite is claimed.

A dependency `call-service` executes in a read-only invocation mode. It may query allowed Junban/plugin state and return bounded service data/logs, but HTTP imports, application mutations, settings/KV patches, nested UI actions, and any full `plugin-outcome` are rejected. The caller remains the only invocation that may return one post-success effect.

Event-origin operation IDs derive from a domain separator plus plugin id/version, source event revision, hook, and action index. For an HTTP-only event, the cursor advances only after the guest returns success; a trap leaves it unchanged and may retry the same stable delivery id. For a SQLite-effect event, a crash after effect commit but before cursor advance replays the exact receipt before advancing; changed output conflicts fail closed.

### Capabilities

Manifest permissions are exact sorted entries. Grants bind package digest + manifest permission set + signer key + persisted `package_generation`. Any package/version/signer/**requested manifest permission-set** change increments that generation, invalidates the grant, and disables activation until approved. Operator grant/revoke changes only the activation epoch and grant row, not package identity. Runtime freshness uses the separate `activation_epoch` defined below; ordinary restart/re-enable never changes what a grant authorizes.

Initial capabilities:

- `tasks:read`, `tasks:write`;
- `projects:read`, `projects:write`;
- `tags:read`, `tags:write`;
- `events:subscribe` with exact event kinds;
- isolated `settings` and `storage`;
- `commands`, `ui:view`, `ui:panel`, `ui:status`;
- `http` with exact HTTPS origins, method set, request/response ceilings, and no redirect;
- `logging`.

Safe clock/random/WASI I/O required by the selected guest toolchain is a declared runtime baseline, not an ambient Junban capability. Raw filesystem, sockets, DNS, WASI HTTP, stdio inheritance, environment, processes, and unknown imports are absent or linked only to explicit denial. TypeScript baseline imports are frozen by an import-linter golden component before its template is accepted.

### Effects, events, and loops

- Commands/UI actions receive an operator operation ID. Event hooks derive a stable operation ID from the durable event revision.
- One successful invocation yields at most one AppService mutation or one plugin-state transaction. Existing 500-affected-task and receipt/event/material bounds remain authoritative.
- Plugin event cursors are durable and advance only after the returned action succeeds or exact-replays. Catch-up is bounded by retained event pages; a cursor behind retention enters explicit resync/suspension rather than guessing.
- One plugin invocation runs at a time per plugin; process concurrency is capped at four.
- Runtime dependency-call depth is capped at eight and detects call cycles. Dependency service mode is read-only and cannot use HTTP or return an effect.
- HTTP use and a returned SQLite effect are mutually exclusive and fail closed if combined. Every accepted HTTP call is at-least-once with a stable delivery id; only SQLite effects receive exactly-once receipt replay.
- An event/self-effect loop is contained by a per-plugin rolling invocation/effect budget. Exhaustion suspends that plugin, records one bounded error, and leaves the server and other plugins active.
- Repeated traps/errors use bounded consecutive-failure backoff and suspension. Manual retry is explicit.

### Package format and trust

A `.jbp` package is a fixed binary envelope rather than a free-form archive:

```text
magic "JUNBANP1"
u32 canonical_manifest_length
canonical_manifest_bytes
32-byte publisher_public_key
64-byte Ed25519_signature
u64 component_length
component_bytes
```

No path extraction, symlink, compression, README, native library, or extra executable is accepted. Initial ceilings are 64 KiB manifest, 32 MiB component, and 33 MiB total package; the TypeScript reference must fit or the plan is revised before implementation rather than bypassed.

The strict typed manifest uses `deny_unknown_fields`, ASCII plugin/capability/entry IDs, semver versions/ranges, sorted unique arrays/maps, integers only, and a fixed no-whitespace serialization. Verification parses then reserializes and requires byte equality. The signature is strict Ed25519 over:

```text
"junban.plugin.package.v1\0" || sha256(manifest_bytes) || sha256(component_bytes)
```

The package identity is SHA-256 of the complete envelope. `key_id` is the lowercase SHA-256 fingerprint of the 32-byte public key. `verify_strict` is mandatory; dalek legacy/hazmat/batch features are absent.

All packages are hash- and signature-verified. There is no unsigned product mode.

- Bundled registry packages are bound by a signed canonical static index whose **release-scoped** root public key is compiled into Junban. The trusted Junban release—not a nonexistent online service—is the update authority for that bundled root/index.
- A local package from an unknown signer requires an explicit operator confirmation displaying exact plugin id/version, full key fingerprint, package hash, permissions, dependencies, and compatibility. Trusting a signer does not auto-enable the plugin.
- Updating a locally installed plugin id requires the same trusted signer and a non-downgrade version unless the operator explicitly confirms a downgrade. A signer change requires uninstall/dependent closure and fresh trust.
- Revoking a locally trusted signer disables its plugins before the trust row changes. A later Junban release may replace its bundled release-scoped root/publisher keys and index as one release artifact; v1 does not claim remote key transparency, cross-release root continuity, or TUF threshold/freeze protection.

#### Offline signing ceremony and custody

The root and reference-publisher private keys are external build inputs owned by the Junban release maintainer. They are never generated into or stored beneath the repository, Cargo target, npm cache, CI artifact, log, command argument, environment value, SQLite profile, or release package.

A small Rust signing tool accepts owner-only key **file descriptors/paths outside the checkout** and refuses a key under the repository or with permissive Unix mode/Windows ACL. It never prints private material. The ceremony order is fixed:

1. build and validate the exact Rust/TypeScript components in the pinned clean environment;
2. produce canonical manifests;
3. sign each finalized JBP1 descriptor/component with the external publisher key;
4. compute the immutable package hashes and produce the canonical bundled index;
5. sign that finalized index with the external release-scoped root;
6. run verification/import/behavior/reproducibility checks using public keys only;
7. commit only public keys, signed envelopes/index, hashes, source, and evidence.

For Phase 7 reference artifacts, the maintainer may use one-time offline keys and destroy the private files after this order completes because the bundled root is release-scoped. Future bundled updates arrive only in another trusted Junban release and may use a new release-scoped root. Lost one-time keys therefore do not block updates or create an informal recovery path. A compromise before commit cancels the ceremony, discards all derived public/signed artifacts, and restarts with new keys. Local third-party publishers remain responsible for durable custody of their own keys; Junban has no escrow or recovery backdoor.

CI and ordinary contributors have no signing access. They verify every committed signature/hash/import, rebuild the examples with pinned toolchains, and compare reproducible component/package bytes where the toolchain proves reproducible; a mismatch blocks but never triggers auto-resigning.

The bundled registry is a local, static, signed index plus content-addressed JBP1 blobs shipped beside Junban. Browse/search/filter/detail/install work offline and use no server-side JavaScript or remote service. Custom/remote registries and auto-update are deferred until a real service and update threat model exist.

### Schema v7 and filesystem ownership

SQLite remains the only live data store. Schema v7 adds bounded normalized authorities for:

- installed package manifest/digest/signer/version/compatibility, monotonic `package_generation`, desired state, and monotonic `activation_epoch`;
- a bounded plugin-identity tombstone/counter so uninstall/reinstall cannot reuse an old package generation;
- exact grants bound to package digest, signer, permission hash, and `package_generation`;
- locally trusted publisher keys and revocation state;
- isolated typed setting values and KV bytes;
- durable event cursor, failure/suspension/backoff state, and dependency lock;
- bundled registry serial/hash observed by this Junban release;
- canonical operation receipts/events for lifecycle, grants, settings/KV, and cursor transitions.

Installed package envelopes live as immutable private content-addressed files under `plugins/packages/sha256/<digest>.jbp`; disposable engine-specific compiled cache lives under `plugins/cache/`. No package path from a manifest is used. Existing private-file helpers and staged-artifact serialization apply.

Install publishes a verified immutable package first, then commits a disabled metadata row. A crash may leave only an unreferenced safe blob, removed by bounded startup cleanup. Uninstall first commits the dependent-safe metadata removal, then best-effort removes now-unreferenced blobs. Cache is never authority.

Complete SQLite backup preserves metadata, grants, settings, KV, and event cursors but not package/cache files. A cursor binds the global event epoch plus revision. Restore validates every typed row and dependency graph, then keeps each `package_generation` and its exact bound grant as inactive historical authority, disables desired state, increments `activation_epoch`, marks packages `reverify_required`, clears backoff, and performs no component compile/activation. Restore cutover rotates the global event epoch, places each plugin cursor at the restored current revision in that new epoch with `resync_required`, and never replays pre-restore hooks; explicit re-enable first receives one bounded read-only resync snapshot, then live events. Reinstall/reverification of the exact digest/signer/manifest may reuse the still-bound grant only after the operator explicitly enables the plugin and sees the permissions again; any authority change increments `package_generation` and requires a new grant. Restore/recovery never constructs Wasmtime.

### Package generation, activation epoch, and host session

Three distinct identities prevent stale privilege/result reuse:

- persisted monotonic `package_generation` identifies code/manifest/signer/requested-permission authority. First install starts at 1. Package update, signer/manifest/requested-permission change, uninstall/reinstall, or explicit replacement increments it; a bounded identity tombstone retains the counter after uninstall. Grants bind it. Enable/disable and ordinary host restart do not alter grant meaning.
- persisted monotonic `activation_epoch` identifies one runtime admission generation. Every enable attempt, disable, grant/revoke transition, package transition, manual retry, server-start activation, host-crash replacement, suspension, restore, and dependency-driven activation change increments it before new work is admitted.
- random process-local `host_session_id` is created at each parent/child handshake and is never SQLite authority.

Every IPC request/reply/outcome and every rendered contribution DTO carries plugin id, package generation, activation epoch, host session id, and invocation id. The parent commits an outcome only if all persisted identities still exact-match and the host session remains current. Browser actions carry package generation + activation epoch + contribution/action id + operation id; a mismatch returns stable stale-generation conflict and refreshes rather than invoking old UI.

Authority transitions acquire the plugin reconfiguration mutex, close admission for the exact activation epoch, cancel and drain its invocations, then commit the package/grant/desired-state change and next epoch before changing the child instance. If the commit fails after a complete drain, unchanged old authority resumes admission. Timeout/partial drain remains fail-closed until bounded recovery. Enable marks the new epoch `starting`, activates the exact package/grants/dependencies, then CASes that epoch `active`; failure CASes it `failed/suspended` without reopening stale authority. A child crash ends its host session, discards all late replies, and transactionally advances affected activation epochs before any replacement spawn.

### Lifecycle and process containment

The retained host-placement ADR owns exact mechanics. For the preferred child-process path:

- `junban-server` spawns a sibling `junban-plugin-host` only after an enabled, verified, dependency-valid graph exists;
- one versioned length-prefixed private stdio protocol carries no bearer or database path and hard-caps every frame;
- the host receives only verified component bytes/identity, exact grants/runtime config, and capability replies, all bound to package generation + activation epoch + host session;
- stdout is protocol only; guest stdout/stderr are discarded or bounded into structured log messages;
- host exit marks active plugins degraded without affecting HTTP/storage, then uses bounded restart/backoff; repeated failure suspends plugins;
- last disable, restore/recovery drain, and graceful server shutdown terminate the child and verify no orphan;
- each plugin owns one serialized Store/instance; a trap discards that instance and cannot poison another;
- server remains usable if the host binary is missing, but enable returns a stable actionable error.

No host process owns the profile lock or survives the server.

### Resource ceilings frozen before Wave 1

Wave 0 verifies and may tighten these initial ceilings; any increase is recorded before implementation:

- installed plugins 64; enabled plugins 16; dependencies/plugin 16; graph depth 16;
- one invocation/plugin; four total; dependency call depth 8;
- component 32 MiB; manifest 64 KiB; package 33 MiB; registry index 4 MiB;
- Wasm linear memory 64 MiB for Rust profile and 128 MiB for signed TypeScript profile; one memory/table/instance/store unless WIT-generated baseline proves a smaller exact count;
- command/UI wall time 1 second; event/render 250 ms; compile/instantiate 10 seconds; epoch cancellation plus host-future timeout;
- guest stack 2 MiB; table elements 10,000; hostcall copy 4 MiB; output 256 KiB; UI 256 nodes/depth 8/64 KiB text; action payload 32 KiB;
- log 32 KiB/invocation and 4 KiB/line; KV 2 MiB/plugin and 64 KiB/value; settings 64 KiB/plugin;
- HTTP request/response 1 MiB each, 5 seconds, exact HTTPS origin, no userinfo/query/fragment in configured origin, no redirects, no raw credential injection;
- event queue 256; catch-up page existing 100/2 MiB; rolling event/effect limit 100/minute/plugin; three consecutive failures before suspension.

`StoreLimits` is not treated as a process RSS limit. Active host memory and growth remain independently measured and gated.

## Public contract

All plugin administration routes are operator-only and absent from the automation catalog. Exact final DTOs are generated from Rust, but the route families are frozen:

- list/detail installed plugins and lifecycle/error/dependency/grant state;
- inspect local package, then install with exact expected package hash/signer/permission confirmation;
- list/search bundled registry, inspect package, install exact id/version/hash;
- enable, disable, uninstall, retry, trust/revoke publisher, grant/revoke permission;
- read/update one plugin's typed settings;
- invoke a contributed command;
- render a declared view/panel/status item and submit a declared structured action.

Every mutation uses a client operation ID and strict bounded body. Package upload uses its own 33 MiB staged body path rather than the ordinary 512 KiB JSON limit. Unknown plugin API routes remain operator-only. Host/origin, maintenance admission, staged-artifact serialization, restore drain, diagnostics redaction, and request-id rules remain unchanged.

Plugin command IDs are `plugin-id:local-id`. Contribution IDs are manifest-bound and cannot shadow first-party route/action/shortcut IDs.

## Declarative UI contract

The host accepts only bounded typed nodes: stack/row, heading/text, badge/metric/progress, button, text/number/select/toggle input, task list/reference, divider, and empty/error state. Controls require accessible labels and emit only manifest-declared action IDs with bounded scalar/object values.

The renderer rejects unknown nodes/props, duplicate IDs, excessive depth/count/text/payload, unsafe URLs, arbitrary class/style, HTML, Markdown, script, image data, event code, and first-party command/route impersonation. Text is ordinary React text. Icons come from a host allowlist. Plugin failure uses the preserved error/retry presentation and cannot escape an error boundary.

Contribution slots remain the legacy-authorized navigation/tools/workspace views, sidebar panels, and status items. Exact placement and responsive behavior are frozen by Wave 0 visual authorities before UI work. Contributed UI appears only from server-confirmed exact package-generation + activation-epoch + host-session state. Every action submits those identities; disable/revoke/host failure removes or invalidates stale contributions without deleting plugin settings/KV.

## Implementation waves

### Wave 0 — authorities, spikes, and plan closure

- update upstream/plugin research and this context map;
- capture immutable legacy-rendered Extensions/contribution visual authorities;
- freeze WIT, package/index/signature golden vectors, limits, schema-v7 shape, public route families, threat model, and cross-platform matrix;
- implement temporary isolated in-process/on-demand host probes plus Rust/TypeScript golden components;
- record five-sample placement/default/Rust/TypeScript evidence and ADR; delete losing scaffolding;
- pass high-risk planning review, then architecture review of the measured placement before Wave 1.

### Wave 1 — package, dependency, domain, and persistence authority

- create the SDK contracts, JBP1 parser/verifier/packer vectors, registry verifier, semver graph, IDs/capability/manifest/UI validation;
- add schema v7, installed/grant/trust/settings/KV/cursor/failure authorities, migration/restore/open validation, lifecycle receipts/events, and private content-addressed staging;
- add package/registry/dependency/permission/restore hostile tests;
- pass database-dominant review; close every material finding with focused regression.

### Wave 2 — optional runtime and capability bridge

- build the selected lazy host, exact Wasmtime 45.0.3 feature set, selective WASI P2 linker, import/grant enforcement, limits, stores, IPC, dependency services, callbacks, cancellation, crash/restart/suspension, and no-orphan shutdown;
- execute guest outcomes through application services only after successful bounded return;
- add denied import/network/filesystem, CPU, memory, stack, output, malformed UI, dependency recursion, host crash, and partial-effect tests on Linux/macOS/Windows;
- pass the security-dominant sandbox gate.

### Wave 3 — server lifecycle, API, registry, commands, and events

- compose lazy supervisor/event cursor/restore drain/maintenance fencing;
- add operator-only generated routes, package inspection/install/lifecycle/trust/grants/settings, bundled registry, contribution render/action, command palette execution, and durable event catch-up;
- rerun schema-v7 Phase 5 conformance with the catalog still exactly 87;
- pass API-contract review.

### Wave 4 — preserved Extensions and contribution UI

- add lazy Settings **Extensions**, Restricted Mode/community confirmation, package permission/signer review, registry browse/search/filter/detail, settings, lifecycle/error/retry, and empty/loading states;
- add trusted declarative renderer and exact contribution slots without arbitrary guest rendering;
- pass immutable screenshots, keyboard, axe, untrusted-text, failure, revocation, mobile/desktop, and stale-generation tests;
- pass frontend/accessibility review.

### Wave 5 — SDK/examples, evidence, dogfood, and closure

- complete Rust SDK and TypeScript template docs; build/package/run Pomodoro, automation, and import references on Linux/macOS/Windows;
- dogfood local signer trust, registry install, dependencies, permissions/revocation, commands/events/KV/settings, UI/actions, crash/retry, backup/restore, disable/uninstall, and no-runtime-Node;
- capture authoritative default/Rust/TypeScript memory/cold/warm/growth evidence and long-run cleanup;
- run full validation, supply-chain/license checks, hostile matrix, final security review, docs/outcome/ledger, and squash to one phase commit.

## Frozen validation and evidence

### Focused contract suites

- manifest/package/index canonical golden vectors, wrong key/signature/hash/size/trailing-byte/unknown-field failures;
- semver missing/incompatible/duplicate/self/cycle/depth/fanout/order/dependent disable/uninstall/update/downgrade failures;
- schema v6→v7 migration, future/open/restore validation, package reconciliation, disabled restore, receipts/events/cursors/KV/settings bounds;
- WIT import subset, unknown import, missing capability, revoked/stale generation, malformed output and UI;
- CPU epoch, memory/table/stack/grow, hostcall/output/log/HTTP, concurrent invocation, dependency recursion, event loop, cancellation, crash/restart/no-orphan;
- AppService-only mutations, trap-before-commit, exact receipt replay, cursor crash window, changed replay conflict;
- operator auth/Host/Origin/body/staging/restore/diagnostic redaction and frozen catalog;
- React safe text, accessibility labels, node/depth/payload bounds, stale contribution removal, error boundary/retry.

### Cross-platform matrix

Linux, macOS, and Windows jobs each:

- build/test SDK and host;
- build the Rust reference with pinned Rust 1.93 `wasm32-wasip2` and exact `wit-bindgen`;
- build the TypeScript reference with pinned Node/pnpm/jco/componentize-js, then run the resulting component without Node;
- run package/signature/dependency and hostile trap/CPU/memory/import/crash tests appropriate to the host;
- prove server shutdown leaves no plugin-host process.

Linux cgroup v2 remains the authoritative memory host. Cross-platform jobs prove contract/build/runtime behavior, not Linux memory numbers.

### Optimized performance protocol

Wave 0 freezes numeric active-plugin budgets from the measured spike. Final evidence has three distinct reports/workloads:

1. **Default/no plugin:** five matched Phase 6 parent/Phase 7 head optimized pairs, same Phase 1 workload; ≤24 MiB max warm, ≤32 MiB peak, median growth ≤`max(15%, 1 MiB)`, one Rust server, no plugin-host/Wasmtime/Node.
2. **Rust plugin:** fresh profile, install/verify/compile/enable, 100 warm commands, 100 events including AppService effects/replay, UI renders/actions, disable/cleanup; server+host cgroup/process tree, cold and p95 latency, peak/warm/growth, no Node.
3. **TypeScript plugin:** same isolated protocol with the TypeScript reference; never merged into Rust/default numbers and no resident Node after build.

All evidence records exact commit/binary/package/component/index hashes, OS/kernel/toolchains, Wasmtime config, profile/package sizes, sample values, process boundaries, cleanup, and contention. Quick/contended runs are preliminary only.

### Mature final commands

```bash
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
cargo audit
cargo deny check
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
pnpm audit --audit-level high
git diff --check
```

Exact plugin SDK/template/hostile/benchmark commands are added and documented in Wave 0–2 before being acceptance evidence.

## Security threat model

Untrusted actors/material:

- plugin package bytes, manifest text, signatures/keys from unknown local publishers, component imports/exports/memory, TypeScript-generated engine code, guest text/log/UI/action/HTTP material, registry bytes, dependencies, restored rows/files, and event replay;
- a malicious plugin with every permission it requested except raw authority that is never grantable.

Trusted boundaries:

- the operator may trust a signer and grant displayed permissions;
- the shipped bundled-registry root and Junban release artifact;
- Wasmtime's documented sandbox within its pinned version, while still isolated from the server by the measured placement;
- Rust host/application/storage code and generated contracts.

Controls:

- signature+hash does not make guest behavior safe; Wasmtime and grants remain mandatory;
- exact generation-bound grants, selective imports, one returned effect, application validation, deterministic receipts, runtime limits, and child containment;
- package/registry canonicalization and strict signatures, private atomic store, no archive extraction;
- no raw token/secret/DB/profile path in host or guest, no inherited stdio/env/fs/network;
- restore disables and re-verifies; revoke drains before authority changes;
- structured host rendering and escaped text only;
- bounded diagnostics without package bytes, secrets, sensitive URLs, or unrestricted guest logs.

Same-user access to profile files remains operator authority. The sandbox protects Junban data and availability from a package running with declared grants; it does not defend against an attacker who already controls the Junban binary/profile token/filesystem account.

## Recovery and rollback

- Schema v7 uses the existing verified pre-migration backup and atomic migration. Failure leaves v6 restorable; future schema fails closed.
- Package install/replacement is immutable and content-addressed; publication-before-row may leave only a removable orphan. No half package is activated.
- Enable/grant/revoke/disable, package, and dependency graph changes drain the exact activation epoch before commit. Timeout/partial drain fails closed; completed drain resumes the unchanged old epoch if commit fails, following AI reconfiguration authority.
- Host crash never changes task data. It invalidates the host session, advances affected activation epochs before replacement, re-verifies exact package-generation/grants/graph, and discards late replies; repeated failure suspends without guessing.
- Restore/recovery never starts the host, preserves package generations and grants only as inactive exact historical authority, advances activation epochs, and leaves every plugin disabled/reverify-required.
- Reverting the single Phase 7 commit requires restoring the verified pre-v7 database backup; there is no v7→v6 downgrade or parallel implementation.

## Review checkpoints

1. High-risk planning gate before runtime implementation: scope, WIT/package/trust, authority, limits, persistence/restore, placement protocol, public/UI contract, evidence, and verifiability.
2. Wave 0 architecture gate after the measured host-placement ADR; only the selected path proceeds.
3. Wave 1 database gate for schema v7, graph/grants/KV/cursor/receipts, staging, restore/open validation.
4. Wave 2 security gate for package trust, selective linker, capability enforcement, resources, IPC, effects, crash containment, and hostile matrix.
5. Wave 3 API-contract gate for auth, bodies, idempotency, registry/lifecycle/contribution/event contracts, and unchanged automation catalog.
6. Wave 4 frontend/accessibility gate for exact legacy presentation, permission clarity, safe declarative rendering, revocation/failure/stale state, keyboard/axe/visual acceptance.
7. Wave 5 final integrated security-dominant review after complete code/evidence, followed by focused recheck only for named material findings.

Each gate uses one reviewer. Findings receive stable `P7-*` IDs and status `open`, `fixed`, `rejected`, or `deferred` with reason; closed IDs reopen only on new evidence.

## Risk assessment

- [x] Public API changes: new operator-only plugin routes and generated DTOs; 87 automation tools unchanged.
- [x] Database migration: v6→v7, complete-backup head and restore sanitization.
- [x] Configuration/runtime: sibling host discovery and bundled registry location; no Wasmtime on default path.
- [x] Security boundary: hostile signed guest code, package/index keys, scoped egress, untrusted declarative UI.
- [x] Cross-platform: Wasmtime traps/process lifecycle and Rust/TypeScript author builds on Linux/macOS/Windows.
- [x] Performance: large Wasmtime/TypeScript components measured separately; default 24/32 MiB ceilings remain.
- [x] Approved UI: new visible implementation must match immutable legacy-rendered Extensions authorities.

Largest implementation risks:

1. TypeScript baseline imports or memory exceed initial ceilings. Resolve in Wave 0 by narrowing componentization and recording honest separate budgets; do not weaken default isolation.
2. IPC/callback complexity grows beyond the demonstrated containment value. Keep one host, one serialized store/plugin, length-prefixed frames, and one returned effect; no general distributed runtime.
3. Restore/package authority diverges. Package files are immutable cache-like artifacts; SQLite desired/grant/state authority always disables and re-verifies after restore.
4. Event loops or crash windows duplicate mutations. Deterministic receipt identities and cursor-after-effect replay prevent duplicate domain commits; rolling suspension contains intentional loops.
5. Signature UI is mistaken for behavioral safety. UI separately displays signer trust and requested capabilities; permissions remain required for signed packages.
6. Declarative UI becomes an alternate web framework. Freeze a small node/action set and reject arbitrary style/HTML/URLs instead of adding escape hatches.
7. Wasmtime 45 leaves the latest MSRV line. Exact pin, advisories, and Phase 8/10 dependency review are mandatory; no quiet toolchain bump.

## Decisions and rejected alternatives

- Keep Rust 1.93 and pin Wasmtime 45.0.3 instead of silently raising the whole workspace for 47.x.
- Use WASI P2/custom WIT; reject P3/native component async for v1.
- Use native `wasm32-wasip2` + `wit-bindgen`; reject deprecated `cargo-component` as primary Rust path.
- Use real jco/componentize-js TypeScript with honest separate memory; reject AssemblyScript marketed as TypeScript and any runtime Node.
- Evaluate placement with one bounded spike; reject deciding by intuition or retaining both runtimes.
- Use JBP1 fixed framing; reject zip/tar extraction and its traversal/compression surface.
- Require signature and hash for every package; reject an unsigned product bypass.
- Use a bundled static signed registry; reject a speculative remote marketplace/service/client.
- Store immutable package files outside SQLite but all live state/KV/settings inside SQLite; reject BLOB-heavy database artifacts and a second live store.
- Keep plugin administration operator-only; reject silently changing CLI/MCP scopes/catalog.
- Allow one post-success SQLite effect; use one synchronous at-least-once HTTP import with stable delivery identity, forbid combining it with a returned SQLite effect, and reject transactional claims across external HTTP.
- Keep dependency service calls read-only; reject nested effects/HTTP so only the top-level invocation can return one effect.
- Render trusted declarative nodes; reject guest React/HTML/CSS/JS.
- Keep first-party Phase 2/3 views first-party; do not recreate legacy plugin internals merely because their old registry called them plugins.

## Planning-review ledger

| ID            | Severity | Status | Resolution                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `P7-PLAN-001` | High     | fixed  | Bundled trust is now explicitly release-scoped. The plan defines external maintainer custody, a repository-refusing private-key input, exact artifact-finalization/signing order, public-only CI verification, compromise cancellation, and one-time-key rotation/recovery through a later trusted Junban release. No signing secret enters the repository/logs/artifacts.                 |
| `P7-PLAN-002` | High     | fixed  | WIT now has one synchronous HTTP-import model only, no outcome intents. Every HTTP invocation is honestly at-least-once with stable delivery identity and no SQLite atomicity; HTTP and a returned SQLite effect are mutually exclusive. Dependency service mode is read-only and forbids HTTP/effects. Event cursor ordering is explicit for HTTP-only and receipt-backed SQLite effects. |
| `P7-PLAN-003` | High     | fixed  | Separate persisted `package_generation` and `activation_epoch` plus process-local `host_session_id` now define grants, every transition, drain/CAS ordering, restore behavior, IPC outcome fencing, and browser action freshness. Package authority changes invalidate grants; restart/re-enable epochs do not silently broaden them.                                                      |

The focused planning recheck approved all three corrections with no new blocker. Wave 0 implementation is authorized; the measured placement still requires its planned architecture gate before Wave 1.
