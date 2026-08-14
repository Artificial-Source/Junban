# Phase 7 context map and execution contract

Date: 2026-08-12
Status: completed and accepted. Waves 0–5 passed their focused gates, all named findings are closed or explicitly disposed, and the final integrated review approved the corrected runtime. Clean candidate `7ac35e3588a0521671de19ac16bfa4ffc4ddd9f7` passed authoritative dogfood, separate five-sample default/Rust/TypeScript product evidence, Linux/macOS/Windows host/composition/reference matrices, and all 13 immutable Phase 7 visual comparisons with baseline PNGs unchanged. The single-squash and exact-head CI publication gate completes Phase 7; [`phase-7-outcome.md`](phase-7-outcome.md) indexes the accepted evidence and remaining later-phase obligations.
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

- Workspace crates: `junban-domain`, `junban-app`, `junban-storage`, `junban-server`, `junban-cli`, `junban-mcp`, lazy `junban-ai`, pure `junban-plugin-sdk`, and isolated `junban-plugin-host`.
- Wave 3 product composition and operator APIs are implemented and focused API-contract recheck accepts `P7-W3-API-001`–`004` as fixed. The signed bundled registry is embedded, all plugin administration remains operator-only, mutation bodies and idempotency/replay are typed and exact, lifecycle/contribution/event routes are generated, and the automation catalog remains exactly 87.
- Wave 4's lazy preserved Extensions UI and trusted contribution renderer are implemented. Focused frontend/accessibility recheck accepts `P7-W4-REV-001`–`005` as fixed; plugin/frontend tests, TypeScript checking, and all 13 immutable visual comparisons pass without changing baseline PNGs.
- Wave 5 reference sources, source-manifest tooling, finalized signed reference packages/index, permanent public checker, product dogfood, cross-platform matrices, and authoritative clean-candidate performance reports are complete. [`phase-7-wave-5-protocol.md`](phase-7-wave-5-protocol.md) remains the accepted contract and [`phase-7-outcome.md`](phase-7-outcome.md) records closure.
- The detailed Wave 1/2 bullets below are retained as historical accepted checkpoints; statements that a later packet was then pending describe that exact earlier boundary and are not the current status.
- Historical Packet A exact commit `651cf7530c951302be0e135143360706a42a9eac` integrated private protocol v2/product/session fencing and the bounded multi-runtime child, and its hostile-runtime/security review found no material issue. Exact `073f00d`, `d641d69`, `ff76e01`, `71aad74`, `dbf63a5`, and later supervisor/resync/composition corrections retained their focused boundaries; subsequent exact-head CI and the integrated Wave 2 security gate accepted the completed supervisor, resync, Slices 2C/2D/2E, and Wave 2. Earlier statements that parent supervision, callback composition, or `P7-2D-DB-002` were open are historical snapshots only.
- SQLite schema head remains v7; accepted Wave 1 persistence owns normalized plugin package, trust, grants, settings, KV, dependencies, cursors, invocations and health authority. Packet B commit `ae9cd24` integrates the typed due-retry, activation-completion, attempt-failure and atomic graph-fence lifecycle APIs, with database corrections approved at exact `e573cfe`. Focused planning recheck **APPROVE** at exact `f6183fd9ffdbe5879600cf7c071157e78e615ebb` fixes and closes `P7-PLAN-2C-005`. Follow-up commit `656e8431956dd3aebf7dc86029e5130beff930cd` makes request and receipt validators accept zero or exactly one `Failing` entry and reject multiple; focused triggerless coverage proves backup/restore/reopen, exact replay and fail-closed corruption handling. Its focused database review found no material issues and returned **APPROVE** after two focused tests and the full `junban-storage` validation passed. The supervisor may consume these APIs. This follow-up changes no schema, DTO, event, OpenAPI or migration authority.
- Verified component-source port commit `48ac139` is integrated. Its focused security/integrity review verdict is **APPROVE** with no material issues, so the parent supervisor may consume `AppService::open_plugin_component_sources`. Static Linux/macOS/Windows path review and 13 focused source/package/normal-open/restore tests passed. The public hidden `OpenedPluginComponentSource::from_verified_package_file` constructor is trusted in-repository storage authority only and must not be called by the supervisor. No stable finding ID was created because the review found no issue.
- Strict parent process transport corrections at exact `ddacfa2d65c4b4a373f8165f20033bad1ffbfc2f` passed focused security recheck; `P7-PC-SEC-002`/`003` remain fixed and `P7-PC-SEC-001` remains rejected under the explicit same-user/install-directory threat model. Wakeable-driver correction `c9474bce9258dfe6072f2bc702f658d497be1be2` passed focused security recheck and closed `P7-WAKE-SEC-001`. These authorities were later composed and accepted as part of Wave 2; their exact focused review boundaries remain historical evidence.
- `FeatureSettings` contains only six first-party feature toggles. `/settings/plugins` is intentionally rejected today, and `FeaturesTab` documents that plugin keys are unsupported.
- `docs/architecture.md` reserves `junban-plugin-sdk` for WIT/package contracts and `junban-plugin-host` for the measured optional runtime.
- `docs/performance.md` requires no Wasmtime initialization on ordinary startup.
- The CLI/MCP catalog remains the frozen independent 87 tools. Plugin administration and contributed commands do not silently expand it.
- Phase 6 final hosted evidence is the immediate default-path baseline: 8.3711 MiB median / 8.8477 MiB maximum warm and 8.9727 MiB peak for the matched disabled workload, below the frozen 24/32 MiB ceilings.

### Current upstream checkpoint

Verified on 2026-08-04:

- Production pins Wasmtime/`wasmtime-wasi` **36.0.13**, the patched 24-month LTS line compatible with Junban's Rust 1.93.0 pin. Newly issued `RUSTSEC-2026-0222` blocks the historical 45.0.3 spike line; 36.0.13 is unaffected by `RUSTSEC-2026-0223`. The 45.0.3 measurements retain placement history only and must be replaced for active-runtime acceptance.
- Product runtime uses Component Model + WASI Preview 2. Wasmtime 36.0.13 starts from defaults off with only `runtime`, `cranelift`, `component-model`, and `async`; `wasmtime-wasi` defaults stay off. Preview 1, Preview 3, pooling, GC, cache, profiling, and component-model async guest ABI are out of scope.
- The accepted product placement is exactly one on-demand child process. Its one Engine owns a bounded map of at most 16 activation-fenced plugin runtimes; every entry owns one serialized Component, selective Linker, Store, generated instance and guest state. Loads are sequential and dependency-first. The parent owner process and child each independently enforce one active invocation per plugin and four active invocations total; a nested dependency invocation counts against both limits and fails immediately with a bounded stable error when either admission fence is unavailable. Per-plugin child processes are rejected.
- Slices 2B.1–2B.2 apply profile-specific `StoreLimits`, finite per-invocation fuel, a 2-MiB Wasm stack, bounded host resources/logs/stderr/output, exact 1,000/250-ms watchdog deadlines, and epoch/cancel/drain ownership around the implemented one-runtime checkpoint. The deny-by-default linker defines only actual Junban imports, requires grants for every capability-bearing one and, for Rust only, defines the exact five frozen WASI interfaces. Failed and stopped Stores are destroyed before terminal/control acknowledgement and cleanly replaced from retained compiled authority. The approved hostcall-fuel focused recheck marked `P7-PLAN-RUNTIME-001` and `P7-RUNTIME-SEC-001` fixed. The focused Slice 2C planning verdict at exact reviewed HEAD `442ebdd61e71a19a3e906b33b54bf7857ad555f8` is **APPROVE**, with no blockers: `P7-PLAN-2C-001`–`003` remain closed, and `P7-PLAN-2C-004` plus `P7-PLAN-2C-004-EVENT-ATOMICITY` are fixed and closed. Slice 2C is therefore authorized to implement from both planning and security. The exact 30-second compile/load timeout remains parent-supervisor kill/reap authority because synchronous child compilation is not safely interrupted locally. `P7-DEP-001` remains open, and Wave 2 is not accepted.
- Replacement CI run `31296663305` at exact head `ce80dead79c5ec2dadd95bddb8202ee7dbd2bf46` passed every Rust, Rust supply-chain, frontend/repository, release E2E, Ubuntu containment, Windows containment and macOS containment job. Process-memory calibration run `31296660062` at the same exact head passed. The macOS containment job passed three strict exact-head executions: original `93202756069`, rerun `93205509663`, and rerun `93207040552`. This fixes and closes both the old macOS containment blocker and the replacement-CI gate at `ce80dea`. These runs predate integrated Packet B `ae9cd24`, Packet A `651cf75` and database corrections `e573cfe`; Packet A acceptance still comes only from its exact-commit hostile-runtime/security review, and Packet B approval still comes only from its focused database recheck.
- Integrated Packet A/B head `0f2f9b31633470dc75973fb15aef99ade354eafb` passed full CI run `31300532652`: Frontend/repository job `93212480064`, release E2E `93212480099`, Rust `93212480101`, Rust supply chain `93212480103`, containment macOS `93212480105`, Windows `93212480137`, and Ubuntu `93212480144`. Process-memory calibration run `31300530297` passed Windows job `93212474022`, Ubuntu `93212474036`, and macOS job `93212474038`; this prior accepted gate remains intact. Later CI run `31303724227` at exact `2c8affb028af27372437be0f8827f0f375029e16` passed every non-Rust job. Its Rust job completed workspace tests and release-binary compilation, but GitHub cancelled the job at the workflow's 20-minute limit before step completion. This was a CI job-time-budget interruption, not a product or test failure. Commit `4fbd1001a3496d8012f8e45586d478b033d38a68` changes only the Rust job timeout to a bounded 30 minutes. The later exact-`c9474bc` gate below supersedes only that pre-supervisor current-head gap; run `31303724227` remains part of the retained history, and neither run accepts Slice 2C or Wave 2.
- Exact pre-supervisor driver head `c9474bce9258dfe6072f2bc702f658d497be1be2` passed GitHub CI run `31310661503` with conclusion **SUCCESS**: Rust job `93237883593` **SUCCESS**; Release binary E2E job `93237883622` **SUCCESS**; Plugin host containment (windows-latest) job `93237883626` **SUCCESS**; Plugin host containment (ubuntu-latest) job `93237883627` **SUCCESS**; Frontend and repository job `93237883639` **SUCCESS**; Plugin host containment (macos-latest) job `93237883653` **SUCCESS**; and Rust supply chain job `93237883670` **SUCCESS**. Phase 7 process-memory calibration run `31310658785` also concluded **SUCCESS**: Calibrate plugin host (ubuntu-latest) job `93237877430` **SUCCESS**; Calibrate plugin host (macos-latest) job `93237877473` **SUCCESS**; and Calibrate plugin host (windows-latest) job `93237877480` **SUCCESS**. This exact-head evidence proves integrated codec, verified source, process, storage and wakeable-driver behavior at the pre-supervisor boundary. The Rust job completed successfully beyond the former 20-minute interruption under the bounded 30-minute timeout, validating the `4fbd100` CI correction. It excludes the in-progress final supervisor, does not accept Slice 2C or Wave 2, does not close `P7-DEP-001`, and does not broaden any focused review verdict.
- Rust guests use stable `wasm32-wasip2` plus `wit-bindgen`; `cargo-component` is being deprecated and is not the authoring authority.
- TypeScript uses exact build-only `@bytecodealliance/jco` 1.26.1 and `@bytecodealliance/componentize-js` 0.22.0. A component embeds StarlingMonkey and is expected to add roughly 8 MiB or more before guest heap; its package/memory/cold-start evidence remains separate.
- Package signatures use strict Ed25519 verification (`ed25519-dalek` 2.2.0) and existing SHA-256. Full TUF, Sigstore, Warg, OCI registry clients, Minisign as a runtime ABI, Extism, WASI P3, and resident Node are excluded from v1.

Primary upstream sources are retained in [`plugin-runtime-research.md`](plugin-runtime-research.md) and include:

- <https://docs.wasmtime.dev/api/wasmtime/component/index.html>
- <https://docs.rs/wasmtime/36.0.13/wasmtime/>
- <https://docs.rs/wasmtime-wasi/36.0.13/wasmtime_wasi/>
- <https://rustsec.org/advisories/RUSTSEC-2026-0222.html>
- <https://rustsec.org/advisories/RUSTSEC-2026-0223.html>
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

Wave 0 froze thirteen independent immutable legacy-rendered scenes in [`phase-7-legacy-visual-baseline/`](phase-7-legacy-visual-baseline/README.md), exact commit and `maxDiffPixelRatio: 0.01`. They cover desktop/mobile Extensions management, Restricted Mode, permission review, registry list/detail/loading/error/empty states, typed settings, Pomodoro view/status in light and dark themes, and a declarative panel/action. Existing first-party Calendar, Matrix, Stats, Timeblocking, Someday, Completed, Cancelled, and Quick Wins remain first-party Phase 2/3 surfaces rather than being rewrapped as plugins.

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
| `plugins/reference/import-typescript/`  | Real TypeScript build-only template/reference proving componentization, typed lists, and one existing bounded bulk-task action                                                                                     |
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
- The accepted Wave 0 placement is exactly one on-demand child host. One Engine multiplexes at most 16 independently activation-fenced plugin runtime entries; per-plugin child processes are rejected. Lazy in-process lost the predeclared fault-containment tiebreak; all temporary spike code and the completed harness are deleted.

A separate small generic “shared” crate is not added. Parent/child protocol types belong in the plugin SDK because both product sides need the versioned plugin-host contract and it carries no engine.

### Accepted host-placement spike and decision rule

Wave 0 built throwaway, isolated probes for:

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

The exact world composition, interface set, typed queries/effects/events/UI/errors, runtime-profile imports and versioning authority is frozen in [`phase-7-wit-contract.md`](phase-7-wit-contract.md).

Package authority: `package junban:plugin@0.1.0` with one synchronous required `plugin` world that exports the guest interface and has no ambient imports. Each package targets its own WIT world that includes this required world and imports only its declared Junban host-capability interfaces plus its frozen runtime-profile baseline. This avoids impossible optional imports while preserving one exact guest ABI and a selective linker. Host implementations may await bounded Rust work internally; WASI P3/native async guest contracts are excluded.

Guest exports:

- lifecycle `activate` / `deactivate`;
- `invoke-command`;
- `handle-event`;
- `render-surface` and `handle-surface-action`;
- `validate-settings`;
- bounded read-only `call-service` for declared plugin dependencies;
- bounded paged `resync` for restore/retention recovery, with only staged noncommitted KV segments and a final leave/replace decision.

Host imports:

- read-only bounded task/project/tag queries;
- separate isolated plugin settings and KV read interfaces;
- bounded monotonic/wall clock;
- one synchronous permission-scoped exact-origin HTTP request interface;
- bounded structured logging;
- bounded call to a declared active dependency's read-only service export.

Guest calls never commit domain or plugin-state writes. A successful ordinary command/event/surface-action export returns one typed `plugin-outcome` containing at most one application mutation request (single or existing bounded bulk operation), **or** one isolated KV patch. Render, service and validation exports have their own closed typed return shapes; structured logs use the bounded host import. No opaque JSON/bytes field can substitute for these typed contracts.

There are no deferred HTTP intents in `plugin-outcome`. HTTP exists only as a synchronous host import so the guest can inspect the bounded response. The host records whether an invocation used HTTP and rejects any mutation or plugin-state patch returned by that invocation; an invocation is either externally effecting through HTTP or eligible for one post-success SQLite effect, never both.

The parent validates and commits the one SQLite effect only after the guest returns successfully. Trap, timeout, malformed output, cancellation, or oversized material therefore commits no task/plugin-state mutation. Existing AppService mutations remain the semantic authority; the WIT world does not duplicate domain rules.

Every HTTP-capable command, UI action, or event hook owns a consume-once parent permit and makes zero or one logical callback. It carries exactly one transport-injected stable `x-junban-plugin-delivery-id`; redirects, cookies, proxies, credentials and automatic transport retries are forbidden. Durable `DispatchingHttp` precedes send. A same-process post-send ambiguity may resend only the identical in-memory request and delivery ID without rerunning the guest. Process loss leaves the dispatch unresolved and never reruns the guest or reconstructs a request. External delivery is honestly at-least-once only through that exact same-process resend rule; no atomicity between remote HTTP and SQLite is claimed.

A dependency `call-service` executes in a read-only invocation mode. It may query allowed Junban/plugin state and return bounded service data/logs, but HTTP imports, application mutations, settings/KV patches, nested UI actions, and any full `plugin-outcome` are rejected. The caller remains the only invocation that may return one post-success effect.

Event-origin operation IDs derive from a domain separator plus plugin id/version, source event revision, hook, and action index. Reservation also binds the exact retained event content hash, revision and expected cursor. For a delivered event, the accepted domain effect, KV patch, or HTTP terminal result and exact source-cursor advance terminalize in one transaction where its delivery mode permits that result; trap/invalid output commits neither. Changed output conflicts fail closed. A process-lost HTTP dispatch remains unresolved rather than rerunning the guest.

### Capabilities

Manifest permissions are exact sorted entries. Grants bind package digest + manifest permission set + signer key + persisted `package_generation`. Any package/version/signer/**requested manifest permission-set** change increments that generation, invalidates the grant, and disables activation until approved. Operator grant/revoke changes only the activation epoch and grant row, not package identity. Runtime freshness uses the separate `activation_epoch` defined below; ordinary restart/re-enable never changes what a grant authorizes.

Initial capabilities:

- `tasks:read`, `tasks:write`;
- `projects:read`, `projects:write`;
- `tags:read`, `tags:write`;
- `events:subscribe` with exact event kinds;
- isolated `settings` and `storage`;
- `commands`, `ui:view`, `ui:panel`, `ui:status`;
- `services:provide` and `services:consume` scoped to exact dependency/service identities;
- `http` with exact HTTPS origins, method set, request/response ceilings, and no redirect;
- `logging`.

Safe clock/random/WASI I/O required by the selected guest toolchain is a declared runtime baseline, not an ambient Junban capability. Raw filesystem, sockets, DNS, WASI HTTP, stdio inheritance, environment, processes, and unknown imports are absent or linked only to explicit denial. TypeScript baseline imports are frozen by an import-linter golden component before its template is accepted.

### Effects, events, and loops

- Commands/UI actions receive an operator operation ID. Event hooks derive a stable operation ID from the durable event revision.
- One successful invocation yields at most one AppService mutation or one plugin-local KV transaction. Typed plugin settings are operator-owned: guests validate and read them but cannot rewrite user configuration. Existing 500-affected-task and receipt/event/material bounds remain authoritative.
- Plugin event cursors are durable and exact-source bound. Catch-up is bounded by retained pages; a cursor behind retention enters explicit resync/suspension. During Active ordinary delivery, the direct converter admits only seven Task kinds plus create/update/delete Project/Tag/Section; malformed direct events fail closed, while every other or unsubscribed structurally valid kind is a verified cursor-only skip that stops before the first subscribed direct event. Accepted effect/KV/HTTP terminalization and cursor advance are one transaction.
- Resync closes admission and samples epoch/head. A bounded runtime-only transcript proves mandatory Task→Project→Tag pages, global indices, exact after IDs, Tag-only exhaustion marker, zero-through-nine flushes, exactly one completion/finalize, and sorted unique staged-KV digest. Tasks use `revision <= R`; Project/Tag retain their existing later-event anti-join. Resync-tail verification and `StartingCatchUp` use the stricter `Represented`/`Irrelevant`/`Invalidating` classification: only `Irrelevant` events may be cursor-skipped, while any `Invalidating` event discards the attempt and restarts from a fresh head. One final transaction revalidates transcript/session/invocation/KV/epoch/session/tail/cursor, applies the KV choice, CASes `(E,R,false)`, and deletes the invocation. No schema row exists.
- One plugin invocation runs at a time per plugin; process concurrency is capped at four.
- Runtime service depth counts edges: root is 0, the eighth service edge is allowed, and the ninth is rejected before dispatch; cycles fail closed. Separate dependency activation depth remains 16. Service mode is read-only and cannot use HTTP or return an effect.
- HTTP use and a returned SQLite effect are mutually exclusive and fail closed if combined. One top-level callback permit allows zero or one logical call; only identical in-memory ambiguity may resend. Process loss remains unresolved and never reruns guest code.
- An event/self-effect loop is contained by a per-plugin rolling invocation/effect budget. Exhaustion suspends that plugin, records one bounded error, and leaves the server and other plugins active.
- Repeated traps/errors use bounded consecutive-failure backoff and suspension. Manual retry is explicit.

### Package format and trust

The exact JBP1/JRI1 framing, canonical manifest, cryptographic identities, permissions/dependencies/contributions/settings, component import validation, local inspection and publication contract is frozen in [`phase-7-package-contract.md`](phase-7-package-contract.md).

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

The exact table/receipt/event/migration/restore/reconciliation authority is frozen in [`phase-7-schema-contract.md`](phase-7-schema-contract.md).

SQLite remains the only live data store. Schema v7 adds bounded normalized authorities for:

- installed package manifest/digest/signer/version/compatibility, monotonic `package_generation`, desired state, and monotonic `activation_epoch`;
- one profile-global monotonic next-package-generation allocator so uninstall/reinstall, pruning, and receipt expiry can never reuse old package authority;
- exact grants bound to package digest, signer, permission hash, and `package_generation`;
- locally trusted publisher keys and revocation state;
- isolated typed setting values and KV bytes;
- durable event cursor, failure/suspension/backoff state, and dependency lock;
- bundled registry serial/hash observed by this Junban release;
- canonical global receipts/events for operator-visible install/lifecycle/grant/policy/settings transitions, plus plugin-local receipts for runtime invocation/KV/cursor transitions.

Installed package envelopes live as immutable private content-addressed files under `plugins/packages/sha256/<digest>.jbp`; disposable engine-specific compiled cache lives under `plugins/cache/`. No package path from a manifest is used. Existing private-file helpers and staged-artifact serialization apply.

Install publishes a verified immutable package first, then commits a disabled metadata row. A crash may leave only an unreferenced safe blob, removed by bounded startup cleanup. Uninstall first commits the dependent-safe metadata removal, then best-effort removes now-unreferenced blobs. Cache is never authority.

Operator-visible plugin mutations each consume one ordinary global revision/event/receipt. Runtime invocation receipts, KV commits, cursor advances, failure counters, and backoff are transactional plugin-local bookkeeping: they do not recursively publish global events or consume global revision. A transition into failed/suspended/degraded state may publish one bounded plugin resource event; plugin event subscriptions cannot subscribe to plugin-internal event kinds.

Complete SQLite backup preserves metadata, grants, settings, KV, and event cursors but not package/cache files. A cursor binds the global event epoch plus revision. Restore validates every typed row and dependency graph, then keeps each `package_generation` and its exact bound grant as inactive historical authority, disables desired state, increments `activation_epoch`, marks packages `reverify_required`, clears backoff, and performs no component compile/activation. Restore cutover rotates the global event epoch, places each plugin cursor at the restored current revision in that new epoch with `resync_required`, and never replays pre-restore hooks; explicit re-enable first completes the bounded paged resync/final-KV handoff, then live events. Reinstall/reverification of the exact digest/signer/manifest may reuse the still-bound grant only after the operator explicitly enables the plugin and sees the permissions again; any authority change increments `package_generation` and requires a new grant. Restore/recovery never constructs Wasmtime.

### Package generation, activation epoch, and host session

Three distinct identities prevent stale privilege/result reuse:

- persisted `package_generation` identifies code/manifest/signer/requested-permission authority and is allocated from one profile-global monotonic sequence. Every first install, package update, signer/manifest/requested-permission change, uninstall/reinstall, or explicit replacement consumes the next globally unique value; uninstall never rewinds the allocator. Grants bind it. Enable/disable and ordinary host restart do not alter grant meaning.
- persisted monotonic `activation_epoch` identifies a runtime admission or graph-fence generation, not every health-state change. Enable, explicit manual retry and a due automatic retry each increment it exactly once while entering `starting`; enable/manual retry begins a fresh failure series, while automatic retry preserves the prior `failure_count`. Disable, grant/revoke, package, restore and other authority changes that invalidate admitted work also advance it once. `loaded`, same-attempt `starting`→`active`, and ordinary plugin-local trap, invocation-timeout or resource-failure transitions retain the current attempt epoch. A child/session-fatal failure instead advances every plugin in the complete selected graph exactly once in one atomic graph fence before replacement.
- random process-local `host_session_id` is generated before each connect/spawn attempt, before Hello can succeed or fail. It is not persisted plugin authority, but it remains the canonical graph-fence receipt/session identity even when spawn or Hello never succeeds.

Every IPC request/reply/outcome and every rendered contribution DTO carries plugin id, package generation, activation epoch, host session id, and invocation id. The parent commits an outcome only if all persisted identities still exact-match and the host session remains current. Browser actions carry package generation + activation epoch + contribution/action id + operation id; a mismatch returns stable stale-generation conflict and refreshes rather than invoking old UI.

Authority transitions acquire the plugin reconfiguration mutex, close admission for the exact activation epoch, cancel and drain its invocations, then commit the package/grant/desired-state change and next epoch before changing the child instance. If the commit fails after a complete drain, unchanged old authority resumes admission. Timeout/partial drain remains fail-closed until bounded recovery. Enabling a disabled plugin or explicitly retrying a `degraded`, `failed`, `suspended` or `reverify_required` plugin is an operator rearm: it clears `failure_count`, `last_error_code` and `next_retry_at` before marking one new epoch `starting`. A due automatic retry marks one new epoch `starting` while preserving the prior `failure_count`. Each path then loads the exact package/grants/dependencies, completes required resync/catch-up, and same-epoch CASes `active`. An ordinary plugin-local trap, invocation timeout or resource failure same-epoch CASes to its next bounded `degraded`/`failed`/`suspended` state and replaces only that plugin's Store/instance; suspension clears desired enablement and siblings remain active.

A child/session-fatal graph fence covers the complete selected nonempty graph of at most 16 plugins and has either zero or exactly one `Failing` entry, never multiple. It has one operation identity and is exactly one AppService mutation, one SQLite transaction, one global revision, one bounded `plugin.health_changed` event, and one durable operation receipt. It is not N plugin mutations, events, or receipts. Its canonical request and durable receipt result each encode the same sorted, unique, complete, bounded list of per-plugin results. Every result contains the exact expected and new activation epoch, prior and target health, stable cause, desired-enable outcome, and dependency disposition needed for deterministic replay or changed-request conflict. The existing `AffectedIds.plugin_ids` contains every changed plugin exactly once in sorted order, so catch-up/resync refreshes the graph from this single event envelope. The session ID is generated before connect and remains the canonical receipt authority even when spawn or Hello never succeeds. This uses the existing event, receipt, and affected-ID shapes; it introduces no new event/schema/OpenAPI shape or migration.

The graph fence has exactly two variants:

- **Triggered:** one exact plugin-correlated trigger is `Failing` + `CompileLoad` for that plugin's compile/load failure or timeout, or `Failing` + `ChildFatal` for an exact correlated fatal protocol/runtime event. Its exact transitive selected dependents are `SkippedDependent` + `DependencyFailed`. Every other selected entry is `LoadedSibling` + `SessionLost`.
- **Triggerless:** Hello failure, idle child exit, uncorrelated EOF/transport/worker/process/control failure, or any other session-fatal condition for which no plugin identity was authorized must not falsely blame a deterministic plugin. It has zero `Failing`, zero `SkippedDependent`, and every selected entry is `LoadedSibling` + `SessionLost`.

An empty selected graph remains `Dormant` and creates no host session or graph fence. If a fresh nonempty graph fails before component bytes, triggerless fencing still advances every selected durable `starting` or `active` epoch exactly once before later retry/respawn. A source/package verification or read failure attributable to one plugin is not reclassified as idle/triggerless; it follows its exact plugin-local/package or compile/load authority already frozen above.

The whole-graph epoch/session CAS, all transition updates, affected IDs, event, and receipt commit or roll back together. Exact replay returns the one receipt, while a changed canonical request conflicts. For every selected entry whose expected epoch and session still match—whether `starting` or `active`—the mutation increments its epoch exactly once and records its bounded failure progression at that new epoch. It records no material failure at the old epoch and cannot increment an affected plugin twice. Both variants preserve the existing per-plugin `degraded`→`failed`→`suspended` progression at the new graph-fence epoch, and suspension clears desired enablement. Late old-session or old-epoch frames cannot commit. A later manual or due retry is a separate attempt, increments once again into `starting`, and retains that retry epoch through `Loaded`→resync/catch-up→`active`. An interrupted `starting` attempt may therefore move E→E+1 when the graph-fatal fence invalidates the lost child session and later E+1→E+2 for its retry; those distinct fence and retry generations are intentional, not double-counting one attempt.

Focused planning recheck **APPROVE** at exact `f6183fd9ffdbe5879600cf7c071157e78e615ebb` fixed and closed `P7-PLAN-2C-005`. Packet B follow-up commit `656e8431956dd3aebf7dc86029e5130beff930cd` now makes request and receipt validators admit the two frozen zero-or-exactly-one `Failing` shapes and reject multiple `Failing` entries. Two focused tests and full storage validation passed; the focused database review returned **APPROVE** with no material issues after checking triggerless backup/restore/reopen, exact replay and corruption rejection. The supervisor may consume the corrected API. No schema, DTO, event, OpenAPI or migration authority changed.

### Product host discovery and private protocol v2

The product supervisor has one non-configurable discovery rule: resolve the exact sibling of `current_exe()` named `junban-plugin-host{EXE_SUFFIX}`. It never searches `PATH` and accepts no CLI flag, configuration key or runtime environment variable that overrides the executable. The candidate must be an absolute strict regular executable; symlinks and Windows reparse-point candidates are rejected rather than followed. Unix also requires executable mode bits. Spawn clears the complete environment and pipes only the private protocol streams. A missing, wrong-type, non-executable, symlink/reparse or wrong-host candidate returns a stable actionable enable error while ordinary Junban remains available.

Only tests may call a separate non-product explicit-path constructor. That constructor accepts one absolute path populated from Cargo's compile-time-known `env!("CARGO_BIN_EXE_junban-plugin-host")` binary path; it is unavailable to product composition and cannot become a runtime override.

Packet A commit `651cf75` bumps the private host protocol from v1 to **v2** before parent composition. The exact protocol name/version are `junban-plugin-host-v2` and `2`. Parent `Hello` and child `Hello` reply both carry the exact compiled `env!("CARGO_PKG_VERSION")` Junban product-version string as `junban_version` in addition to the protocol identity and fresh host session. After successful spawn and before sending `Hello`, the parent starts one exact 1,000-ms monotonic control deadline; it sends no component bytes until the complete reply exact-matches inside that deadline. Protocol-name, protocol-version, product-version or session mismatch, or deadline expiry, is child/session-fatal with no v1 fallback or compatibility negotiation; the parent kills and reaps before durable fencing or replacement. Canonical frame goldens cover both Hello directions, every mismatch, timeout and reap. The completed single hostile-runtime/security review accepted Packet A's protocol-v2/product/session implementation at exact commit `651cf7530c951302be0e135143360706a42a9eac` with no material security issues. The exact 1,000-ms parent control deadline remains the Packet C contract frozen at docs commit `18fbb87`; the Packet A verdict does not claim review of later codec or parent-supervisor code.

This private correction does **not** change WIT or its frozen SHA-256, generated invocation/callback bodies, JBP1/JRI1, permission/package hashes, OpenAPI, or schema version/table shape. Same-epoch activation CAS and bounded crash graph-health behavior are internal persistence semantics, not new public/package contracts.

### Lifecycle, durable authority and process containment

The retained host-placement ADR owns the one-child decision. Slice 2C applies these exact mechanics:

- `junban-server` spawns the discovered sibling only after SQLite/AppService selects an enabled, verified, dependency-valid graph;
- one child Engine owns at most 16 plugin runtime entries. Loads are sequential dependency-first. Each activation-fenced entry owns one serialized Component/Linker/Store/instance and state;
- parent and child independently enforce one invocation per plugin and four active invocations total. Nested dependency `Invoke` work counts as another active invocation and fails immediately with a bounded stable admission error when the per-plugin or total permit is unavailable;
- canonical u32be-length-prefixed JSON headers remain capped at 256 KiB, while exact hash/length-bound raw bodies follow only the already-authorized component, invocation, callback and outcome frames. No bearer, profile path or database path crosses the protocol;
- stdout is protocol only; guest stdout/stderr are absent, discarded or bounded into structured log messages;
- an ordinary plugin-local trap, invocation timeout or plugin resource failure is a same-attempt transition at that plugin's current activation epoch. It destroys and replaces only that plugin's Store/instance from its retained Component/Linker; sibling plugin entries remain active and the child process survives;
- protocol or transport failure, EOF, process exit, worker loss, or a malformed or stale session is child/session-fatal. Any compile/load timeout or failure that requires killing and reaping the singular child is likewise child/session-fatal: close all admission, kill and reap as required, invalidate the session, and discard every late frame before the graph fence and replacement;
- last disable, restore/recovery drain, and graceful server shutdown close admission and cancel work, then use one exact 1,000-ms monotonic parent control deadline for drain and shutdown acknowledgement; expiry or error kills the child, and every path waits/reaps before clearing the session and verifies no orphan on Linux, macOS and Windows;
- no host process owns the profile lock or survives the owner process.

SQLite/AppService exclusively owns durable desired state, activation epochs, runtime health, retry/backoff, dependent propagation, events and receipts. The supervisor owns only process/session/admission mechanics and requests typed AppService transitions; it never mutates or caches a second durable lifecycle authority.

An explicit manual retry—including from `suspended` or `reverify_required`—is an operator rearm that transactionally clears `failure_count`, `last_error_code` and `next_retry_at` before one epoch increment into `starting`. Enabling a currently disabled plugin does the same and starts a fresh failure series. A due automatic retry instead preserves the prior `failure_count` while performing its one epoch increment into `starting`, so unattended consecutive failures continue `degraded`→`failed`→`suspended`. A successful child `Loaded` reply is runtime-local evidence, not `active`. Required resync and retained-event catch-up complete first; only then may AppService same-epoch CAS `starting`→`active`, clearing the failure count, error and backoff to end the series. An ordinary plugin-local trap, invocation timeout or resource failure records the next persisted failure progression at that plugin's current attempt epoch; terminal suspension clears `desired_enabled`. Every material transition receives its exact bounded receipt and event while counter-only bookkeeping remains revision-neutral.

Child/session-fatal failure first closes admission and kills/reaps as required, then uses the one-envelope atomic graph-fence AppService mutation defined above for the complete selected nonempty graph. A plugin-correlated trigger produces exactly one `Failing` entry, exact transitive `SkippedDependent` entries, and `LoadedSibling` entries for every other selection; a triggerless session failure produces only `LoadedSibling` + `SessionLost` entries and never invents a plugin trigger. The whole-graph expected epoch/session CAS covers every selected `starting` or `active` plugin. The epoch advances, cause-specific health transitions, sorted complete request/results/affected IDs, single `plugin.health_changed` event, and single durable receipt commit together only at the new epoch; any mismatch rolls back the entire mutation. The graph-fence transaction completes before replacement. Exact replay returns that receipt, a changed request conflicts, and no per-plugin old-epoch material transition is emitted. A later manual or due retry enters a separate fresh `starting` epoch, and successful `Loaded`→resync/catch-up→`active` retains that retry epoch.

### Slice 2D delivery, resync, HTTP, event, and service authority

The initial Slice 2D API/planning review at exact `08c42c5b44411fdb4b81545c993a60a80960682d` returned **REVISE**, closed HTTP `P7-PLAN-2D-003`, and required the corrections below. Narrow recheck at exact `073f00d98dac4b9110ec028da01d0fb71eaa3ae3` returned **APPROVED**, closing `P7-PLAN-2D-001`, `002`, and `004` and authorizing coding at that reviewed boundary. Subsequent persistence, event-converter, and HTTPS focused rechecks approved exact `d641d69`, `ff76e01`, and `71aad74`; their precise statuses are in [`phase-7-review-ledger.md`](phase-7-review-ledger.md). Final callback composition remains in progress and unaccepted, and persistence finding `P7-2D-DB-002` remains an open server migration/removal blocker. Focused recheck approved `P7-PLAN-2D-005` and its UUID subsidiary at exact `dbf63a58f38df245b0b62337b29c644b8054984c`, authorizing ordinary app/storage query coding; final callback composition remains unaccepted.

`PluginDeliveryAuthority` is bounded runtime-local state and is never serialized. Its existing digest remains the canonical length-framed plugin ID, package generation, activation epoch, current host session, invocation ID, payload SHA-256, and `StartingResync | StartingCatchUp | Active` mode under `junban.plugin.delivery-authority.v1\0`. The payload digest is exact: command/action is SHA-256 of the canonical validated private invocation body; retained event is `SHA-256("junban.plugin.retained-event-payload.v1\0" || raw committed-event content hash || u32be(body length) || exact canonical private body)`; resync is the raw existing `plugin_resync_request_hash(session)`. Every received private body must pass decode→canonical-re-encode byte equality before hashing.

The persisted `request_hash` is exactly `SHA-256("junban.plugin.invocation-request.v2\0" || one-byte hook tag command=0/event=1/action=2/resync=3 || u64be(canonical persisted-entry-ID byte length) || canonical UTF-8 persisted entry ID || raw delivery-authority digest)`. The same authority/final hash must match reserve, every transition, terminalization, verified cursor-only skip, and resync finalization. `StartingResync` is resync-only. `StartingCatchUp` is retained-`HandleEvent`-only and cannot authorize command/action/HTTP/domain/KV/arbitrary-cursor work; exact catch-up reaches head before same-epoch activation.

On any process/session loss, all non-HTTP `reserved` and `effect_committing` rows are abandoned regardless of Starting or Active mode. Only `dispatching_http` transitions to `ambiguous_http`; existing ambiguity remains. A replacement process gets a fresh session/authority/request hash, and no dead-process non-HTTP Active row survives.

`PluginResyncTranscript` is bounded runtime-local, nonpersisted state. Its initial digest is exactly `SHA-256("junban.plugin.resync-transcript.v1\0" || raw delivery-authority digest || raw existing plugin_resync_request_hash(session))`. Each private request/outcome must pass canonical decode→re-encode equality and folds exactly as `SHA-256("junban.plugin.resync-transcript-step.v1\0" || prior digest || u32be(global step index) || one-byte snapshot=0/flush=1/finalize=2 tag || u32be(request length) || exact request bytes || u32be(outcome length) || exact outcome bytes)`. Compact semantic counters retain global page order, per-kind counts/bytes/last IDs/digests, flush/finalize state, and replacement-candidate count/bytes/digest.

Task→Project→Tag order is mandatory, including at least one page per kind; kind/`after_id` exact-match, and only exhausted Tag carries the terminal marker. Tasks use their real `revision <= R`; Project/Tag use the existing retained-tail anti-join. Flush requests use contiguous indices `0` through at most `9`: each preterminal `more` is nonempty, exactly one response is `complete` (possibly at index `0`), and nothing follows it; exactly one finalize follows. Resync segments accept only canonical SET operations and reject shared-WIT delete. Keys are globally sorted/unique. The replacement candidate starts empty, so omitted old keys are deleted; its exact sorted resulting-set map is hashed as `SHA-256("junban.plugin.resync-kv.v1\0" || u32be(count) || length-framed entries)`. Leave discards that candidate, replace commits it, and zero-entry replace empties KV.

One transaction revalidates transcript/session/invocation/final request hash/candidate digest and bounds/epoch/current session/classified contiguous tail/expected cursor, applies the KV choice, CASes `(E,R,false)`, and deletes the invocation. Crash before commit discards transcript/candidate and restarts; crash after commit is recognized by cursor. No row/migration is added.

HTTP request headers are exactly `accept`, `accept-language`, `content-type`, `if-match`, `if-none-match`; exposed response headers are exactly `cache-control`, `content-language`, `content-type`, `etag`, `expires`, `last-modified`, `location`, `retry-after`. Names are sorted unique exact lowercase ASCII tokens of 1–64 bytes. Values are ≤8 KiB visible ASCII plus internal HTAB, with no edge OWS/CRLF/NUL/control. Each side allows ≤32 entries and ≤64 KiB aggregate name+value bytes. Authorization/proxy authorization, cookies/set-cookie, Host, content length, forwarding/proxy, hop-by-hop, and every `x-junban-*` header are forbidden. Transport owns Host/content length, injects one delivery ID, forces identity encoding, and disables cookies/redirects/proxies/retries. Valid nonallowlisted response headers are omitted; duplicate/invalid allowlisted or oversized raw metadata is `invalid-response`. A consume-once permit allows zero/one logical callback; `DispatchingHttp` is durable before send, second calls never send, same-process ambiguity can resend only the identical in-memory request/delivery ID, and process loss stays unresolved without guest rerun.

The exhaustive event converter directly admits only Task create/update/complete/uncomplete/cancel/reopen/delete plus create/update/delete Project/Tag/Section. Nondelete type/primary/snapshot resource and ID must agree; delete has exact typed primary and no snapshot. Task uses retained snapshot; other WIT revision is the enclosing event revision. Malformed direct events fail closed, and no live read or affected-ID synthesis repairs them.

For resync-tail verification and `StartingCatchUp`, baseline-relevant affected IDs are exactly retained Task/Project/Tag affected IDs. `Represented` requires a subscribed direct event whose snapshot/delete subject covers all of them: Task has exactly its primary task and no project/tag IDs; Project has exactly its primary project and no task/tag IDs; Tag has exactly its primary tag and no task/project IDs; Section has none. `Irrelevant` requires no baseline-relevant affected IDs and an otherwise valid non-invalidating cursor-only envelope. Every other event is `Invalidating`, including moved/reordered/bulk/restored, cascade/multi-ID direct completion or deletion, Project/Tag/Section deletion cascades, unsubscribed Task/Project/Tag direct mutations, undo/import, and future events with baseline IDs.

Final tail verification discards transcript/candidate and restarts at a fresh head on any `Invalidating` event; it can never cursor-skip one. After a successful resync at `R`, `StartingCatchUp` delivers `Represented`, skips only `Irrelevant`, and restarts resync if it encounters `Invalidating`; only then can it reach head and activate. Active ordinary delivery retains exact event hash/revision/cursor reservation, subscribed direct dispatch, bounded cursor-only verification, and atomic accepted effect/KV/HTTP terminal result plus source cursor. These rules cover rows omitted by Task `revision <= R` and the Project/Tag anti-join. Service depth counts edges separately from graph depth: root 0, eighth allowed, ninth rejected before dispatch, while activation depth stays 16.

This clarification changes no WIT/WIT SHA/generated body, JBP1/JRI1/package hash, OpenAPI/DTO, schema SQL/version/table shape, or dependency shape.

### Resource ceilings frozen for implementation

Wave 0 initially froze projected selected-child active gates of Rust 18.6016/19.5078 MiB current/peak and TypeScript 357.334/415.6201 MiB. Real-owner Slice 2E zero-swap evidence at exact `e196313b5a463681254a2401ebc9787f99e97e13` disproved those projections: clean run `31629776892` measured normalized scale-1 maxima of 73,342,976/105,062,400 bytes for Rust and 553,934,848/645,459,968 bytes for standalone TypeScript. The formal amendment applies the original `max(25%, 8 MiB)` Rust and `max(25%, 16 MiB)` TypeScript headroom rule and freezes revised active scale-1 cgroup gates of 91,678,720/131,328,000 bytes (87.431641/125.244141 MiB) for Rust and 692,418,560/806,824,960 bytes (660.341797/769.448242 MiB) for TypeScript. Scale 4/16 memory is informational. Wave 5 replaces the normalized active gates with integrated product evidence; the ordinary no-plugin 24/32-MiB ceiling remains unchanged.

- installed plugins 64; enabled plugins 16; dependencies/plugin 16; graph depth 16;
- one active invocation/plugin and four active invocations total, enforced independently by parent and child; nested dependency invokes count against both admission bounds and fail immediately/bounded on saturation; dependency service-call edge depth 8 (root 0, eighth allowed, ninth rejected);
- component 32 MiB; manifest 64 KiB; package 33 MiB; registry index 4 MiB;
- Wasm linear memory 64 MiB for Rust profile and 128 MiB for signed TypeScript profile; one memory/table/instance/store unless WIT-generated baseline proves a smaller exact count;
- command/UI wall time 1 second; event/render 250 ms; compile/instantiate 30 seconds; epoch cancellation plus host-future timeout;
- guest stack 2 MiB; table elements 10,000; hostcall copy 4 MiB; output 256 KiB; UI 256 nodes/depth 8/64 KiB text; action payload 32 KiB;
- log 32 KiB/invocation and 4 KiB/line; KV 2 MiB/plugin and 64 KiB/value; settings 64 KiB/plugin;
- HTTP request/response 1 MiB each, 5 seconds, exact HTTPS origin, no userinfo/query/fragment in configured origin, no redirects/cookies/proxies/credentials/retries; exact request allowlist `accept`, `accept-language`, `content-type`, `if-match`, `if-none-match`; exact response exposure `cache-control`, `content-language`, `content-type`, `etag`, `expires`, `last-modified`, `location`, `retry-after`; ≤32 sorted unique lowercase-token entries, ≤8 KiB/value and ≤64 KiB aggregate name+value bytes;
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

- build the selected lazy host on exact Wasmtime/`wasmtime-wasi` 36.0.13, selective WASI P2 linker, import/grant enforcement, limits, stores, IPC, dependency services, callbacks, cancellation, crash/restart/suspension, and no-orphan shutdown;
- execute guest outcomes through application services only after successful bounded return;
- add denied import/network/filesystem, CPU, memory, stack, output, malformed UI, dependency recursion, host crash, and partial-effect tests on Linux/macOS/Windows;
- pass the security-dominant sandbox gate.

### Wave 3 — server lifecycle, API, registry, commands, and events

Status: completed and accepted by focused API-contract recheck and final Phase 7 closure.

- lazy supervisor/event cursor/restore drain/maintenance fencing is composed through ordinary `ServerState`;
- operator-only generated routes cover package inspection/install, lifecycle, trust, grants, settings, signed bundled registry, contribution render/action, command execution, and durable event catch-up;
- `P7-W3-API-001`–`004` are fixed after focused recheck across pre-body operator authorization, concrete typed bodies, mutation identity/idempotency/byte-stable replay, registry/lifecycle/contribution/event contracts;
- schema-v7 conformance retains the independent automation catalog at exactly 87.

### Wave 4 — preserved Extensions and contribution UI

Status: completed and accepted by focused frontend/accessibility recheck and final Phase 7 closure.

- lazy Settings **Extensions**, Restricted Mode/community confirmation, exact permission/signer review, registry browse/search/filter/detail, settings, lifecycle/error/retry, and empty/loading states are implemented;
- trusted declarative rendering and server-confirmed command/navigation/panel/status contribution slots do not execute guest React/HTML/JavaScript;
- `P7-W4-REV-001`–`005` are fixed after focused recheck for command generation/epoch/session fencing, exact scoped permissions, refresh on every plugin resource event, accessible uninstall confirmation, and browser enable/disable behavior;
- plugin/frontend tests and TypeScript checking pass; all 13 immutable visual comparisons pass at `maxDiffPixelRatio: 0.01`, and baseline PNGs are unchanged.

### Wave 5 — SDK/examples, evidence, dogfood, and closure

Status: open. Planning corrections `P7-W5-PLAN-001`–`003` are fixed and closed after focused planning recheck **APPROVE** with no blockers; no Wave 5 authoritative evidence is claimed.

[`phase-7-wave-5-protocol.md`](phase-7-wave-5-protocol.md) is the implementation and evidence authority. In order, Wave 5 must:

- implement and test SDK-owned typed source-manifest, runtime-manifest derivation, package/index pack-sign-verify tooling, and a permanent public-only artifact checker with disposable external keys before the signing ceremony;
- build/package/run Pomodoro, automation, and TypeScript import references on Linux/macOS/Windows, then complete the external one-time-key ceremony with public-only checks before key destruction;
- dogfood local/bundled trust, dependencies, scoped permissions/revocation, lifecycle, commands, exact events/effect/replay, settings/KV, contributions/actions, crash/retry, backup/restore, disable/uninstall, and no-runtime-Node;
- capture five-sample clean-candidate default, package-specific Rust, and TypeScript reports under the corrected separate corpora and frozen byte budgets; scale 4/16 remains functional/informational;
- run full validation, supply-chain/license checks, hostile/cross-platform matrix, final security review, docs/outcome/ledger, one Phase 7 squash commit, and exact-head final CI.

## Frozen validation and evidence

### Focused contract suites

- manifest/package/index canonical golden vectors, wrong key/signature/hash/size/trailing-byte/unknown-field failures;
- semver missing/incompatible/duplicate/self/cycle/depth/fanout/order; disable blocks enabled dependents, uninstall blocks every installed dependent, and compatible dependency updates atomically rewrite all locks while incompatible updates fail with the bounded closure;
- schema v6→v7 migration, future/open/restore validation, package reconciliation, disabled restore, receipts/events/cursors/KV/settings bounds;
- WIT import subset, unknown import, missing capability, revoked/stale generation, malformed output and UI;
- CPU epoch, memory/table/stack/grow, hostcall/output/log/HTTP, concurrent invocation, dependency recursion, event loop, cancellation, crash/restart/no-orphan;
- Slice 2C minimum lifecycle/process matrix: one PID loads a dependency graph; 16 runtimes load and a 17th fails closed; four concurrent invocations run while a fifth, a same-plugin second invocation and a saturated nested dependency invoke fail immediately/bounded in both parent and child; a sibling remains active through a same-epoch plugin-local trap and Store replacement; exact triggered compile/load failure/timeout and plugin-correlated fatal protocol/runtime fixtures each cover one complete mixed `starting`/`active`/not-yet-loaded graph and prove exactly one `Failing` trigger, exact transitive `SkippedDependent` + `DependencyFailed` entries, and `LoadedSibling` + `SessionLost` for every other selection; exact triggerless connect/spawn failure, Hello failure, idle exit and uncorrelated EOF/transport/worker/process/control fixtures prove zero `Failing`, zero `SkippedDependent`, all-selected `LoadedSibling` + `SessionLost`, pre-connect session receipt identity, and one epoch advance even before component bytes; empty selection stays `Dormant` with no session/fence; attributable source/package failures retain plugin-local/package or compile/load authority; request/result/affected IDs are sorted, unique, complete and bounded to 16; both variants prove exact before/after epochs, per-plugin failure progression, no old-epoch material transition, and exactly one operation identity/AppService mutation/SQLite transaction/global revision/bounded `plugin.health_changed` event/durable receipt—not N envelopes; focused Packet B validator/receipt/open/backup/restore/replay tests admit zero or one `Failing`, reject multiple and reject wrong role/cause shapes; whole-graph CAS mismatch rolls everything back; exact replay returns the one receipt and a changed request conflicts; one later retry increment, retry-epoch activation and every late old-session/old-epoch frame rejection pass; retry-series fixtures prove manual retry including `suspended`/`reverify_required` and enable-from-disabled clear failure count/error/backoff before exactly one new `starting` epoch, due automatic retry preserves the prior count across its one new epoch and unattended `degraded`→`failed`→`suspended` progression, and successful activation clears the series; compile/load timeout kills and reaps; product host discovery rejects PATH/override, relative, missing, wrong-type, non-executable, symlink/reparse and wrong protocol/product-version candidates; shutdown and failure leave no orphan on Linux, macOS or Windows;
- AppService-only mutations, trap-before-commit, exact receipt replay and changed conflict; Slice 2D delivery-authority, all-hook payload, and final request-hash exact-byte goldens/one-field changes/canonical-body mismatches; mode/fence/head-before-active; and process-loss Active+Starting non-HTTP abandonment with only HTTP ambiguity surviving;
- exact initial/step resync transcript framing/tags/`u32be` index and lengths/request-outcome bytes, canonical body mismatches, page/order/after-ID/terminal/flush-index-0-and-9/index-10 rejection/finalize, SET-only/delete rejection, globally sorted unique candidate, leave/replace/omission/zero-replace, exact resulting-map digest, tail/CAS/crash matrix;
- exhaustive sixteen direct-event conversion and malformed/no-live-read/hash-revision-cursor/atomic terminal-cursor matrix; concurrent moved/reordered/bulk/restored, multi/cascade complete/delete, Project/Tag/Section delete, subscribed/unsubscribed create/update/delete, undo/import/future baseline-ID, irrelevant-event, and invalidating-restart-then-complete tail/catch-up matrix; root-0/eighth-service-edge-allowed/ninth-rejected plus independent activation-depth-16 matrix;
- exact HTTP request/response header names and all case/order/duplicate/value/OWS/control/count/aggregate/raw-metadata limits; forbidden headers and transport-owned Host/content-length/delivery-id/identity encoding; zero/one callback, second no-send, durable pre-send dispatch, exact same-memory resend, and process-restart unresolved/no-guest-rerun retained for fixed/closed `P7-PLAN-2D-003`;
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

Slice 2E's accepted non-shipped normalized harness remains historical runtime calibration only. It does not substitute for Wave 3 ordinary composition or Wave 5 product-integrated evidence.

The exact final authority is [`phase-7-wave-5-protocol.md`](phase-7-wave-5-protocol.md). It requires Linux cgroup v2, `memory.swap.max=0`, file-only reclaim with `swappiness=0`, optimized binaries, runtime no-Node proof, exact process/hash/tool provenance, clean candidate inputs, and five samples for each separate report:

1. **Default/no plugin:** matched Phase 6 base/Phase 7 candidate under the frozen Phase 1 workload; ≤24 MiB maximum warm, ≤32 MiB peak, median growth ≤`max(15%, 1 MiB)`, one server, no host/Wasmtime/Node.
2. **Rust references:** at most one runtime at a time. Each sample runs Pomodoro's exact 100-round command/settings/KV/UI/action corpus, disables and cleans it, then runs automation's exact 100-event/effect/replay corpus. Maxima across all segments must stay ≤91,678,720 current and ≤131,328,000 peak bytes.
3. **TypeScript import reference:** each sample runs only its declared existing bounded bulk command/action corpus. It has no event workload or event-evidence claim. Maxima must stay ≤692,418,560 current and ≤806,824,960 peak bytes.

Scale 4/16 remains functionally required and memory-informational. Latencies are recorded without an invented ceiling. Any behavior, binary, package, index, include-table, checker, protocol, generated-contract, corpus, or budget change after measurement reruns applicable evidence; bounded result-only records may be appended only when they bind unchanged candidate bytes exactly.

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
- bounded diagnostics without package bytes, secrets, sensitive URLs, or unrestricted guest logs;
- supported product packaging installs the server and `junban-plugin-host` sibling directory so it is writable only by the same OS principal that owns the Junban installation or by administrator/elevated authority. Phase 8 target-native package/install evidence and Phase 9 release-packaging evidence must verify this owner/mode/ACL invariant. A less-privileged writer makes the installation unsupported and insecure and requires fail/stop operator guidance; it is not reclassified as an in-scope lower-privilege attacker.

Same-user access to profile files remains operator authority. The sandbox protects Junban data and availability from a package running with declared grants; it does not defend against an attacker who already controls the Junban binary/profile token/filesystem account. This threat-model decision does not claim descriptor-bound execution.

## Recovery and rollback

- Schema v7 generalizes the existing verified SQLite backup helpers to take a pre-v7 snapshot, but not the old fallible post-commit finalizer. Canonical/semantic/FK/integrity checks run before the one commit; pre-commit failure rolls back v6, commit is the last reported migration operation, and later pruning is non-fatal. A crash leaves SQLite's atomic v6 or prevalidated v7 state with the snapshot retained; future schema fails closed.
- Package install/replacement is immutable and content-addressed; publication-before-row may leave only a removable orphan. No half package is activated.
- Enable/grant/revoke/disable, package, and dependency graph changes drain the exact activation epoch before commit. Timeout/partial drain fails closed; completed drain resumes the unchanged old epoch if commit fails, following AI reconfiguration authority.
- Host crash never changes task data. Runtime failure counters/cursors/KV remain plugin-local and cannot create a recursive global event stream. Admission closes and the child is killed/reaped before one atomic graph-fence AppService mutation advances every selected plugin exactly once and records bounded cause-specific graph-health/dependency transitions only at the new epoch. A plugin-correlated failure uses the exact one-trigger/dependent/sibling roles; a triggerless failure uses only `LoadedSibling` + `SessionLost` and never guesses a plugin. The one SQLite transaction also commits one global revision, one bounded `plugin.health_changed` event whose sorted `AffectedIds.plugin_ids` names every changed plugin, and one durable operation receipt containing the canonical bounded complete per-plugin result list. Any epoch/session CAS mismatch rolls all of it back; exact replay returns that receipt and a changed request conflicts. Replacement starts only afterward, re-verifies exact package-generation/grants/graph, and discards old-session/old-epoch replies; a later retry increments once again, while repeated failure follows `degraded`→`failed`→`suspended` without guessing.
- Restore/recovery never starts the host, preserves package generations and grants only as inactive exact historical authority, advances activation epochs, and leaves every plugin disabled/reverify-required.
- Reverting the single Phase 7 commit requires restoring the verified pre-v7 database backup; there is no v7→v6 downgrade or parallel implementation.

## Review checkpoints

1. High-risk planning gate before runtime implementation: scope, WIT/package/trust, authority, limits, persistence/restore, placement protocol, public/UI contract, evidence, and verifiability.
2. Wave 0 architecture gate after the measured host-placement ADR; only the selected path proceeds.
3. Wave 1 database gate for schema v7, graph/grants/KV/cursor/receipts, staging, restore/open validation.
4. Wave 2 security gate for package trust, selective linker, capability enforcement, resources, IPC, effects, crash containment, and hostile matrix. Exact `073f00d` approved/closed Slice 2D planning findings `P7-PLAN-2D-001`–`004`; exact `d641d69`, `ff76e01`, and `71aad74` focused rechecks approved their bounded implementations, with `P7-2D-DB-002` still an open server migration/removal blocker. Focused recheck approved `P7-PLAN-2D-005` and its UUID subsidiary at exact `dbf63a58f38df245b0b62337b29c644b8054984c`, authorizing ordinary app/storage query coding. Callback composition still requires its own validation.
5. Wave 3 API-contract gate for auth, bodies, idempotency, registry/lifecycle/contribution/event contracts, and unchanged automation catalog. Focused recheck accepted `P7-W3-API-001`–`004` as fixed; final Phase 7 closure corroborates the contract.
6. Wave 4 frontend/accessibility gate for exact legacy presentation, permission clarity, safe declarative rendering, revocation/failure/stale state, keyboard/axe/visual acceptance. Focused recheck accepted `P7-W4-REV-001`–`005` as fixed; all 13 immutable visuals pass without baseline changes and final Phase 7 closure corroborates the UI gate.
7. Wave 5 protocol planning gate is **APPROVED** with `P7-W5-PLAN-001`–`003` fixed and closed; final integrated security-dominant review occurs only after complete clean-candidate code/evidence, with focused recheck thereafter only for named material findings.

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
7. Wasmtime 36 is an older but patched LTS line. Exact pins, clean advisories, hostile selected-runtime evidence, and Phase 8/10 dependency review are mandatory; no quiet toolchain bump or return to vulnerable 45.x.

## Decisions and rejected alternatives

- Keep Rust 1.93 and pin patched Wasmtime/`wasmtime-wasi` 36.0.13 LTS; reject vulnerable 45.0.3, short-lived 46/47 lines, a RustSec exception, and a workspace toolchain bump without product need.
- Use WASI P2/custom WIT; reject P3/native component async for v1.
- Use native `wasm32-wasip2` + `wit-bindgen`; reject deprecated `cargo-component` as primary Rust path.
- Use real jco/componentize-js TypeScript with honest separate memory; reject AssemblyScript marketed as TypeScript and any runtime Node.
- Evaluate placement with one bounded spike; reject deciding by intuition or retaining both runtimes.
- Use JBP1 fixed framing; reject zip/tar extraction and its traversal/compression surface.
- Require signature and hash for every package; reject an unsigned product bypass.
- Use a bundled static signed registry; reject a speculative remote marketplace/service/client.
- Store immutable package files outside SQLite but all live state/KV/settings inside SQLite; reject BLOB-heavy database artifacts and a second live store.
- Keep plugin administration operator-only; reject silently changing CLI/MCP scopes/catalog.
- Allow one post-success SQLite effect; use one consume-once synchronous HTTP import with stable delivery identity, permit only an identical same-process ambiguity resend, leave process-lost dispatch unresolved without guest rerun, forbid combining HTTP with a returned SQLite effect, and reject transactional claims across external HTTP.
- Keep dependency service calls read-only; reject nested effects/HTTP so only the top-level invocation can return one effect.
- Keep exactly one on-demand child whose one Engine owns at most 16 serialized plugin runtime entries; reject per-plugin child processes and the implemented one-load checkpoint as the final topology.
- Discover only the strict `current_exe()` sibling and require private protocol v2 plus exact product-version handshake; reject PATH/config/environment overrides and v1 fallback. Supported packaging must keep the server/host sibling directory writable only by the installation owner or administrator/elevated authority; a less-privileged writer is an unsupported insecure installation, not an in-scope attacker, and no descriptor-bound execution claim is made.
- Keep SQLite/AppService as the only durable lifecycle/health authority; reject supervisor-owned desired state, epoch, retry, propagation, event or receipt authority.
- Fence a correlated fatal graph with exactly one plugin trigger, but use a triggerless all-session-lost graph when no plugin identity was authorized; reject deterministic blame for Hello/idle/uncorrelated session loss.
- Render trusted declarative nodes; reject guest React/HTML/CSS/JS.
- Keep first-party Phase 2/3 views first-party; do not recreate legacy plugin internals merely because their old registry called them plugins.

## Planning-review ledger

| ID                               | Severity | Status           | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P7-PLAN-001`                    | High     | fixed            | Bundled trust is now explicitly release-scoped. The plan defines external maintainer custody, a repository-refusing private-key input, exact artifact-finalization/signing order, public-only CI verification, compromise cancellation, and one-time-key rotation/recovery through a later trusted Junban release. No signing secret enters the repository/logs/artifacts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `P7-PLAN-002`                    | High     | fixed            | WIT has one synchronous HTTP-import model only and no outcome intents; HTTP and a returned SQLite effect are mutually exclusive, and dependency service mode is read-only without HTTP/effects. Slice 2D keeps that WIT shape while limiting repetition to identical same-process ambiguity, leaving process loss unresolved, and committing an accepted event terminal result with its exact cursor; no remote/SQLite atomicity is claimed.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `P7-PLAN-003`                    | High     | fixed            | Separate persisted `package_generation` and `activation_epoch` plus process-local `host_session_id` now define grants, every transition, drain/CAS ordering, restore behavior, IPC outcome fencing, and browser action freshness. Package authority changes invalidate grants; restart/re-enable epochs do not silently broaden them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `P7-PLAN-2C-001`                 | High     | fixed            | The corrected authority retains exactly one on-demand child and upgrades the implemented one-load checkpoint before parent composition. One Engine owns at most 16 activation-fenced serialized runtimes; sequential dependency-first loading, independent parent/child one-per-plugin and four-total admission, counted nested invokes, plugin-local Store replacement and child/session-fatal failures are exact. Per-plugin processes are rejected.                                                                                                                                                                                                                                                                                                                                                                                          |
| `P7-PLAN-2C-002`                 | High     | fixed            | Product discovery is only the strict absolute `current_exe()` sibling, with no PATH/config/CLI/environment override, no symlink/reparse candidate, a cleared environment, and exact private protocol-v2/product-version handshake before component bytes. Only a tests-only compile-time Cargo binary path may be injected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `P7-PLAN-2C-003`                 | High     | fixed            | Slice 2E may use one non-shipped optimized harness around the real supervisor, storage/AppService and sibling host with tests-only binary injection. It owns replacement Rust/TypeScript and multi-runtime scaling evidence only, not Wave 3 ordinary `ServerState` composition or Wave 5 product-integrated acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `P7-PLAN-2C-004`                 | High     | fixed            | Ordinary plugin-local trap/timeout/resource failure retains the current epoch and replaces only its Store/instance. Child/session-fatal loss atomically advances every matching affected selected plugin exactly once at a new graph-fence epoch before replacement; a later retry advances once again. The focused recheck closed this finding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `P7-PLAN-2C-004-EVENT-ATOMICITY` | High     | fixed            | A child/session-fatal graph fence is one operation/AppService mutation/SQLite transaction/global revision/bounded `plugin.health_changed` event/durable receipt, not N envelopes. One sorted unique max-16 canonical per-plugin result list and sorted `AffectedIds.plugin_ids` make replay, changed-request conflict and graph refresh deterministic; whole-graph CAS and material commit or roll back together. No new event/schema/OpenAPI shape or migration is introduced. The focused recheck closed this finding.                                                                                                                                                                                                                                                                                                                        |
| `P7-PLAN-2C-005`                 | High     | fixed            | The corrected authority distinguishes a one-trigger correlated graph fence from triggerless Hello/idle/uncorrelated session loss, covers the complete selected max-16 graph, forbids multiple `Failing` entries and false plugin blame, preserves one-envelope/CAS/replay/progression authority, and keeps an empty graph `Dormant`. Focused planning recheck **APPROVE** at exact `f6183fd9ffdbe5879600cf7c071157e78e615ebb` fixed and closed the finding. Packet B correction `656e8431956dd3aebf7dc86029e5130beff930cd` implements strict zero-or-exactly-one `Failing` validation and accepted triggerless persistence/replay/corruption guarantees without schema, DTO, event, OpenAPI or migration changes; its focused database review returned **APPROVE** with no material issues after two focused tests and full storage validation. |
| `P7-PLAN-2D-001`                 | High     | fixed and closed | Exact per-hook payload/final persisted request hashing, canonical-body equality, all-stage matching, and complete Starting/Active process-loss handling passed narrow focused recheck at exact `073f00d98dac4b9110ec028da01d0fb71eaa3ae3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `P7-PLAN-2D-002`                 | High     | fixed and closed | Exact transcript framing, compact counters, SET-only empty-based replacement, omission deletion, leave/replace/zero-replace, and one-final-transaction authority passed narrow focused recheck at exact `073f00d98dac4b9110ec028da01d0fb71eaa3ae3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `P7-PLAN-2D-003`                 | High     | fixed and closed | Exact HTTP allowlists/bounds, forbidden/transport-owned headers, consume-once callback, durable pre-send transition, identical same-memory resend, and unresolved process loss were accepted by the initial focused review at exact `08c42c5b44411fdb4b81545c993a60a80960682d`; exact `71aad742cf33ab256a70142858b720146f7dc439` later passed the HTTPS implementation security recheck and closed `P7-2D-SEC-001` with public-IPv4-only transport.                                                                                                                                                                                                                                                                                                                                                                                             |
| `P7-PLAN-2D-004`                 | High     | fixed and closed | Exact affected-ID/subscription classification, restart on every invalidating tail/catch-up event, fail-closed conversion, atomic event result/cursor, and service-depth authority passed narrow focused recheck at exact `073f00d98dac4b9110ec028da01d0fb71eaa3ae3`; exact `ff76e01abec9fb7377210833a48e409d694b6b1b` later passed converter recheck and closed `P7-API-2D-001`–`004`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `P7-PLAN-2D-005`                 | High     | fixed and closed | Ordinary WIT queries lacked exact internal AppService/SQLite ownership, normalized filters, authenticated keyset cursor/private-MAC authority, complete canonical SDK reply-byte accounting, and focused tests. [`phase-7-capability-matrix.md`](phase-7-capability-matrix.md) freezes the minimal authority with no WIT/schema/public/package/dependency change. Focused recheck **APPROVED** the combined authority at exact `dbf63a58f38df245b0b62337b29c644b8054984c`, authorizing app/storage coding only.                                                                                                                                                                                                                                                                                                                                 |
| `P7-W5-PLAN-001`                 | High     | fixed and closed | [`phase-7-wave-5-protocol.md`](phase-7-wave-5-protocol.md) now requires SDK-owned typed source-manifest/runtime-manifest derivation and package/index pack-sign-verify tooling plus a permanent public-only checker before ceremony; disposable external keys prove the pipeline first, and ceremony public checks pass before one-time-key destruction. The Rust packer is the sole runtime-manifest canonicalizer; JRI1 uses the SDK typed serializer without a second canonicalization implementation.                                                                                                                                                                                                                                                                                                                                       |
| `P7-W5-PLAN-002`                 | High     | fixed and closed | The protocol freezes five matched samples per report and package-specific corpora: default Phase 1 matched workload; one-runtime-at-a-time Rust Pomodoro 100-round command/settings/KV/UI/action then cleanup and automation 100-event/effect/replay, gated at 91,678,720/131,328,000 bytes; TypeScript declared bounded bulk command/action only with no event claim, gated at 692,418,560/806,824,960 bytes. Linux zero-swap/file-only-reclaim/no-Node provenance and informational scale 4/16 are exact; no latency ceiling is invented.                                                                                                                                                                                                                                                                                                     |
| `P7-W5-PLAN-003`                 | High     | fixed and closed | The protocol requires every executable input, lock, generated contract, signed artifact, include table, protocol and checker in one clean candidate before evidence; defines exact invalidation and bounded result-only append rules; then requires authoritative evidence, docs/review, one squashed Phase 7 commit, and exact-head final CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The original focused planning recheck approved `P7-PLAN-001`–`003`, after which Wave 0 retained the on-demand child and Wave 1 was accepted. Historical Packet B/process/driver/query/resync checkpoints remain intact at their exact boundaries. Subsequent integrated evidence accepted Wave 2; focused rechecks accepted Wave 3 `P7-W3-API-001`–`004` and Wave 4 `P7-W4-REV-001`–`005` as fixed. The corrected Wave 5 protocol closed `P7-W5-PLAN-001`–`003`, final security recheck closed `P7-FINAL-SEC-001`/`002`, and the clean-candidate dogfood, cross-platform, performance, single-squash, and exact-head CI gates complete Phase 7 as recorded in [`phase-7-outcome.md`](phase-7-outcome.md).
