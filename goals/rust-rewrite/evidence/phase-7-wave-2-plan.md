# Phase 7 Wave 2 — hostile plugin runtime plan

Status: Slice 2B and hostcall-fuel security correction accepted; all `P7-PLAN-2C-001`–`004` plus `P7-PLAN-2C-004-EVENT-ATOMICITY` closed; Slice 2C authorized to implement from planning and security; `P7-DEP-001` open; Wave 2 in progress; clean replacement full CI at the current head pending

## Outcome and boundary

Wave 2 creates the production `junban-plugin-host` child, strict private IPC, selective Component Model/WASI P2 linker, resource/cancellation containment, and parent-side capability/effect/dependency/event callback authority. It proves the runtime against hostile Rust and TypeScript components.

Wave 2 does **not** add public plugin HTTP/OpenAPI routes, registry transport/UI, Extensions UI, CLI/MCP tools, reference plugins, or ordinary `ServerState` startup/restore composition. Wave 3 composes the accepted lazy supervisor and event workers into server lifecycle and adds the operator contract. This preserves the frozen wave boundary while making the runtime independently testable end to end.

## Dependency decision

The historical placement spike used Wasmtime 45.0.3. Newly issued `RUSTSEC-2026-0222` affects that line, so it is blocked for production.

Wave 2 keeps Rust 1.93.0 and pins exact `wasmtime`/`wasmtime-wasi` **36.0.13**:

- 36.0.13 is the patched 24-month LTS line and is unaffected by `RUSTSEC-2026-0223`;
- Wasmtime defaults are off; only `runtime`, `cranelift`, `component-model`, and `async` are enabled;
- `wasmtime-wasi` defaults are off; Preview 2 is direct on this line, while Preview 1/P3 remain absent;
- no advisory exception or workspace toolchain bump is allowed;
- 45-era placement evidence remains historical, but active containment and performance evidence must be replaced on 36.0.13.

`P7-DEP-001` closes only after the exact lock/feature tree, clean audit/deny, hostile runtime, Rust/TypeScript imports, and replacement optimized evidence pass.

## Implementation slices

### Slice 2A — isolated child and exact protocol

Implemented by the focused Slice 2A checkpoint. `crates/junban-plugin-host` is the only crate that depends on exact `wasmtime`/`wasmtime-wasi` 36.0.13. Its reusable codec consumes the SDK's canonical u32be JSON/private-protocol types, exact protocol name/version, bounded raw bodies and full fences; the launched child constructs one configured Engine, re-hashes and compiles one parent-selected component, and never instantiates or links it. Process tests launch the absolute sibling binary with an empty environment, prove protocol-only stdout, bounded redacted stderr, compile failure, state/identity fencing, clean EOF/shutdown, and wait/reap cleanup.

The load frame now carries the already SDK-inspected import/export fingerprint that `Loaded` must echo, and hello carries the existing SDK protocol name as its exact magic. These are minimal additions to the SDK-owned authority rather than a second envelope. Unsupported invoke/cancel/unload/callback cases use the frozen fenced `Failed` frame. Slice 2B must replace `Unavailable` with real selective-linker execution; it does not replace the codec, process loop, load identity, or Engine owner.

Acceptance at this checkpoint: focused SDK/host Clippy and tests, exact dependency/features/audit checks, malformed/truncated/oversized/hash/protocol/type/correlation process coverage, absolute sibling-process environment scrubbing and wait cleanup, and an unchanged Wasmtime-free `junban-server` tree. This does not close `P7-DEP-001` or the Wave 2 security gate.

### Slice 2A.1 — generated typed private body authority

Generate checked-in pure serde body types from the one `plugin.wit` authority and byte-compare regeneration in check mode. Freeze canonical child-private JSON, exhaustive `InvocationKind` and `HostCallKind` request/success/error mappings, invocation-context construction, typed-only size/hash helpers, and malformed/cross-kind/result-branch rejection. Options are explicit value-or-null, variants/results are closed tagged forms, byte lists are canonical unpadded base64url, and parse-then-reserialize equality rejects noncanonical material. This is private transport only; WIT remains the sole public guest ABI.

Implemented on 2026-08-05: the SDK now checks in WIT-parser-generated neutral serde types and generated function argument/result adapters, owns closed request/outcome/host-call envelopes and kind/branch-derived frame/body constructors, derives invocation context from the header fence plus body entry ID, and makes the protocol validator perform one bounded parse-then-reserialize canonical check after raw hash validation. The same generator emits exhaustive neutral↔Wasmtime binding adapters in the child, where compile-time bindgen types and bounded byte conversion round trips are tested without constructing a linker or executing a guest. `ChildFrame::Outcome` now carries its invocation kind. Load bytes remain raw and cancellation remains the only empty callback reply. See [`phase-7-wave-2-slice-2a1.md`](phase-7-wave-2-slice-2a1.md).

Accepted: every request/outcome/callback branch has exact byte/hash goldens; omitted option, unknown/duplicate field, noncanonical bytes, numeric boundary, wrong kind/result and over-limit fixtures fail; generated neutral and Wasmtime binding types have compile-time/round-trip adapters and WIT drift checks. Focused API-contract recheck marked `P7-API-001` fixed and authorized Slice 2B guest execution.

### Slice 2B.1 — selective linker and serial guest execution

Implemented on 2026-08-05 as the bounded first half of Slice 2B. The child re-inspects the exact component against the runtime profile and canonical grants before compilation, constructs a linker containing only actual Junban imports with grants required for every capability-bearing interface, and adds only Rust's five exact frozen WASI 0.2.6 interfaces individually. TypeScript receives no WASI. Rust environment/arguments are empty, stdin is closed, stdout is absent, stderr is a bounded sink, and ambient WASI random, clocks, network, filesystem, processes and broad linker helpers are absent.

One Engine and one load attempt remain process-owned. A dedicated serial runtime thread owns one mutable Store/instance for the loaded activation, applies profile-specific memory/table/instance limits, a 2-MiB Wasm stack, exact per-invocation fuel and epoch-interruption configuration, and retains guest state across successful calls. `Loaded` is emitted only after import/grant/fingerprint validation, selective linking and instantiation. All nine exports use generated neutral↔Wasmtime adapters. A bounded callback rendezvous emits canonical `CapabilityRequest`, routes only the exact pending fence/kind reply, and keeps protocol input live for busy/stale/wrong/duplicate rejection. Guest WIT errors remain `Outcome`; traps/runtime failures remain fenced `Failed` and discard the Store. Idle unload drops the Store/instance.

Retained zero-WASI TypeScript executes every export, separates guest error from trap, retains activation state and unloads cleanly. Retained Rust executes legal settings/storage/log/task callbacks across lifecycle/effect invocations and proves success/error/cancel replies, stale/wrong/duplicate rejection, busy rejection, active cancel/unload/shutdown fail-closed behavior, exact grant denial before load, and idle cleanup. See [`phase-7-wave-2-slice-2b1.md`](phase-7-wave-2-slice-2b1.md).

This checkpoint does **not** complete Slice 2B, the hostile runtime gate, Wave 2 or `P7-DEP-001`.

### Slice 2B.2 — hostile exhaustion, interruption and recovery

Finish wall-deadline epoch interruption, cancellation of blocked host futures, active cancel/drain ownership, bounded host-resource-table behavior, and deterministic Store discard/re-instantiation. Exercise trap, spin, bulk memory operation, grow, table/stack/output exhaustion, timeout, cancellation, EOF/child failure during callbacks, recovery and clean replacement against signed Rust and TypeScript hostile fixtures.

Acceptance: every forbidden WASI/network/filesystem/random/clock import fails before guest execution; all hostile resource/cancellation cases remain contained; no failed or cancelled Store is reused; bounded clean re-instantiation and process cleanup pass on the required platforms. This matrix is explicitly not claimed by Slice 2B.1.

Implemented on 2026-08-05 at the child-only boundary. One watchdog now owns exact 1,000/250-ms invocation deadlines, epoch interruption, callback cancellation, and active control/EOF draining without correctness sleeps. Failed/stopped Stores enter a completion fence, are destroyed before terminal/control acknowledgement, and are replaced from the retained compiled Component; successful Stores retain state. Finite host-resource, guest-log, stderr, output, memory, table, instance, stack, fuel, and frame/callback bounds have launched hostile Rust/TypeScript coverage, as do forbidden imports, malformed/EOF/kill callback races, late replies, replacement, and process reap. CI adds the required Linux/macOS/Windows Rust containment matrix. See [`phase-7-wave-2-slice-2b2.md`](phase-7-wave-2-slice-2b2.md).

The protocol's exact 10-second compile/load authority is unchanged. It is deliberately enforced by the Slice 2C parent through child kill/reap because child-local Wasmtime compilation/initial instantiation is synchronous and not safely epoch-interruptible; Slice 2B.2 makes no false child-local timeout claim. Package signature verification and the opened verified-source bridge likewise remain parent-owned Slice 2C admission before these component bytes reach the child.

Independent security review found `P7-RUNTIME-SEC-001`: typed canonical ABI lifting can allocate native Rust strings/lists/results from 64/128-MiB guest memory before post-lift 4-MiB callback and 256-KiB output serialization bounds run. Exact cross-platform calibration subsequently rejected the macOS `RLIMIT_AS` remedy: a valid process reserves roughly 415 GiB, so its mechanical 519-GiB minimum is not a meaningful backstop. The approved minimal correction instead configures Wasmtime 36.0.13 `Store::set_hostcall_fuel` to **4,464,640 bytes** before every initial and replacement instantiation, with readback asserted. This guest-to-host canonical-lift authority is separate from wasm execution fuel and does not meter host-to-guest values. The bound derives from the 4-MiB callback body plus the largest 139,264-byte valid nested ABI structure and an explicit 128-KiB margin; generated-adapter coverage spans all 11 imports and 9 exports. Rust maximum-valid/oversized imports and the retained TypeScript bulk typed-array oversized-import argument (one 558,081-element `BigInt64Array`, 4,464,648 flat bytes, invoked on the original healthy Store with no capability request published) prove pre-adapter/pre-allocation failure, normalized `resource-limit`, failed-Store destruction and same-process replacement.

The approved focused hostcall-fuel recheck marks `P7-PLAN-RUNTIME-001` and `P7-RUNTIME-SEC-001` fixed. The focused Slice 2C planning verdict at exact reviewed HEAD `442ebdd61e71a19a3e906b33b54bf7857ad555f8` is **APPROVE**, with no blockers: `P7-PLAN-2C-001`–`003` remain closed, while `P7-PLAN-2C-004` and `P7-PLAN-2C-004-EVENT-ATOMICITY` are fixed and closed. Together the planning and security verdicts authorize Slice 2C implementation. They do not close `P7-DEP-001` or accept Wave 2.

On exact code head `0220c8c67bd1da94f90fecc11aeabf87e784f777`, CI run `31294773893` jobs `93197967769`, `93197967800`, and `93197967814` passed Ubuntu, macOS, and Windows plugin-host containment, proving the competing `Timeout`/`ResourceLimit` assertion correction. The same run failed only unrelated storage test isolation and newly disclosed tooling advisories, both fixed at current head `ce80dead79c5ec2dadd95bddb8202ee7dbd2bf46`; a clean replacement full CI run is pending, so neither current-head full-CI green nor Wave 2 acceptance is claimed. Phase 7 process-memory calibration run `31294772199` at `0220c8c67bd1da94f90fecc11aeabf87e784f777` passed.

### Slice 2C — lazy parent supervisor and verified source bridge

Add parent-side supervisor/bridge modules that are constructible without spawning or touching Wasmtime. Storage yields only a strict opened/capped verified component source; no child message contains its filesystem path.

#### One-child runtime topology and admission

Retain exactly one on-demand child process. Its one Engine owns a bounded map of at most 16 activation-fenced plugin runtime entries. Every entry owns one serialized compiled Component, selective Linker, Store, generated instance and guest state. Graph loads are sequential and dependency-first; the child may execute different admitted entries concurrently only within the frozen process limit, while each entry remains serialized.

The parent owner process independently enforces one active invocation per plugin and four active invocations total. The child independently enforces the same one/four bounds rather than trusting the parent. A nested dependency `Invoke` counts as another active invocation at both layers and fails immediately with a bounded stable admission error if its target plugin or the four-total pool is saturated; it never waits while holding the caller in an unbounded queue. Per-plugin child processes are rejected.

The implemented Slice 2B child accepts one load. That code must be upgraded to the bounded runtime map as part of Slice 2C before parent composition; the parent must not compose around the one-load checkpoint and must not spawn one child per plugin.

An ordinary plugin-local trap, invocation timeout or plugin resource failure is a same-attempt transition at that plugin's current activation epoch. It destroys and replaces only that plugin's Store/instance from its retained Component/Linker; sibling plugin entries remain active and the PID survives. Protocol or transport failure, EOF, process exit, worker loss, or a malformed or stale session is child/session-fatal. Any compile/load timeout or failure that requires killing and reaping the singular child is likewise child/session-fatal: close admission, kill/reap as required, invalidate the session and every late frame, persist the atomic graph fence described below, then replace only after durable authority permits it.

#### Product host discovery and protocol v2

Product construction discovers exactly `current_exe()`'s sibling `junban-plugin-host{EXE_SUFFIX}`. It never searches `PATH` and accepts no CLI, configuration or runtime-environment executable override. The path must be absolute and its own metadata must identify a strict regular executable; symlinks and Windows reparse points fail closed, and Unix requires executable mode bits. Spawn clears the full environment. Missing, wrong-type, non-executable, symlink/reparse and wrong-host candidates return a stable actionable enable error without taking down ordinary Junban.

Only tests may use a separate non-product explicit absolute-path constructor populated from Cargo's compile-time-known `env!("CARGO_BIN_EXE_junban-plugin-host")` binary path. That constructor is unavailable to ordinary product composition; no test convenience becomes shipped configuration.

Before parent composition, bump the private protocol from v1 to **v2** with exact name `junban-plugin-host-v2` and numeric version `2`. Parent Hello and child Hello reply each carry the exact compiled `env!("CARGO_PKG_VERSION")` Junban product-version string as `junban_version`, and the parent exact-matches name, version, product version and fresh session before sending component bytes. Mismatch is session-fatal, with no v1 fallback or range negotiation. Canonical frame goldens cover both directions and wrong name/protocol/product/session.

This is a private host correction only. WIT and its frozen SHA-256, generated invocation/callback bodies, JBP1/JRI1, permission/package hashes, OpenAPI, and schema version/table shape do not change. Same-epoch activation CAS and bounded crash graph-health transitions are internal persistence semantics.

#### Durable lifecycle authority

SQLite/AppService exclusively owns desired enablement, activation epochs, health, retry/backoff, dependent propagation, events and receipts. The supervisor requests typed transitions and owns only ephemeral child/session/admission mechanics; it cannot persist or invent a parallel lifecycle state.

An explicit manual retry—including from `suspended` or `reverify_required`—is an operator rearm that transactionally clears `failure_count`, `last_error_code` and `next_retry_at` before incrementing the activation epoch exactly once into `starting`. Enabling a currently disabled plugin does the same and starts a fresh failure series. A due automatic retry instead preserves the prior `failure_count` while incrementing exactly once into `starting`, so unattended consecutive failures continue `degraded`→`failed`→`suspended`. A child `Loaded` frame is not `active`. Required restore/retention resync and retained-event catch-up complete first; then and only then AppService may same-epoch CAS `starting`→`active`, clearing the failure count, error and backoff to end the series. An ordinary plugin-local trap, invocation timeout or resource failure records the next failure progression at that plugin's current attempt epoch; suspension clears desired enablement. Each material plugin-local transition produces exactly one bounded receipt and one event; same-state counters and retry bookkeeping remain revision-neutral.

A child/session-fatal failure closes admission, kills/reaps as required and invalidates the session. Before replacement, the graph fence has one operation identity and is exactly one AppService mutation, one SQLite transaction, one global revision, one bounded `plugin.health_changed` event, and one durable operation receipt. It is not N plugin mutations, events, or receipts. Its canonical request and durable receipt result each encode the same sorted, unique, bounded list of at most 16 per-plugin results. Every result contains the exact expected and new activation epoch, prior and target health, stable cause, desired-enable outcome, and any dependency disposition needed for deterministic replay or changed-request conflict. The existing `AffectedIds.plugin_ids` contains every changed plugin exactly once in sorted order, so catch-up/resync refreshes the graph from this single event envelope. No new event/schema/OpenAPI shape or migration is introduced.

The whole-graph epoch/session CAS, all transition updates, affected IDs, event, and receipt commit or roll back together. Exact replay returns the one receipt; a changed canonical request conflicts. The mutation covers every affected selected plugin whose expected epoch and session still match, whether it is `starting` or `active`: any plugin whose compile/load failed, loaded/active siblings, and not-yet-loaded or skipped dependents. It increments each affected plugin's activation epoch exactly once and records its appropriate bounded failure progression only at that new epoch. It does not emit any per-plugin old-epoch material transition and cannot increment an affected plugin twice. The failing plugin records the stable `child-fatal` or `compile-load` cause; loaded/active siblings record `child/session-lost`; not-yet-loaded or skipped dependents whose prerequisite cannot activate record `dependency_failed`. The existing `degraded`→`failed`→`suspended` progression applies at the new graph-fence epoch, and suspension clears desired enablement. Any epoch/session CAS mismatch aborts fail closed rather than partially transitioning the graph, and the graph-fence transaction completes before replacement.

Late old-session or old-epoch frames cannot commit. Any later manual or due retry is a separate attempt, increments once again into `starting`, and retains that retry epoch through successful `Loaded`→resync/catch-up→`active`. An interrupted `starting` attempt may therefore move E→E+1 on graph-fatal fencing and later E+1→E+2 on retry. This intentionally records distinct lost-session fencing and retry generations; it is not double-counting one attempt.

Acceptance: zero construction/spawn for an empty graph; one PID loads a deterministic dependency graph; 16 runtime entries succeed and a 17th fails closed; parent and child each prove four-total/fifth, same-plugin and nested-saturation behavior; a sibling remains active through same-epoch plugin-local trap and Store replacement; a child-fatal fixture mixes `starting`, `active` and not-yet-loaded plugins and proves exact before/after epochs, no old-epoch material transition, and exactly one operation identity/AppService mutation/SQLite transaction/global revision/bounded `plugin.health_changed` event/durable receipt for the complete graph fence—not N envelopes; its canonical request/result list is sorted, unique, bounded to 16 and complete for epoch, health, cause, desired-enable and dependency disposition; `AffectedIds.plugin_ids` is the matching sorted changed-plugin set; whole-graph CAS mismatch rolls everything back; exact replay returns the one receipt and a changed request conflicts; one later retry increment, retry-epoch activation and every late old-session/old-epoch frame rejection pass; retry-series fixtures prove manual retry including `suspended`/`reverify_required` and enable-from-disabled clear failure count/error/backoff before exactly one new `starting` epoch, due automatic retry preserves the prior count across its one new epoch and unattended `degraded`→`failed`→`suspended` progression, and successful activation clears the series; the 10-second compile/load timeout kills and reaps; the host-discovery rejection matrix and exact v2/product-version frame goldens pass; and drain/cancel/shutdown/failure leave no orphan on Linux, macOS and Windows. Wave 3—not this slice—wires the supervisor into ordinary `ServerState` startup/restore/maintenance.

### Slice 2D — capability, effect, dependency, HTTP, and event callback authority

Translate WIT values to bounded AppService requests only after exact manifest-entry and generation-bound grant checks. Top-level command/surface/event/resync calls reserve accepted Wave 1 invocation authority before dispatch. At most one post-success SQLite effect may commit through `plan_plugin_invocation_commit`; trap/cancel/invalid output commits nothing. Dependency service calls are read-only, effect/HTTP-free, ancestry/depth bounded, and generation fenced.

The sole synchronous HTTPS import is parent-owned, exact-origin/method/header/body granted, redirect- and credential-free, DNS/IP fail-closed, and bound to the stable delivery operation ID. Reservation moves to `DispatchingHttp` before send; ambiguous post-send failure becomes `AmbiguousHttp` and is never guessed successful. Event delivery uses bounded catch-up/resync callback authority and advances the cursor only in the accepted terminal transaction; bookkeeping events cannot recursively invoke plugins.

Acceptance: denial precedes guest input; one-effect atomicity/replay/changed conflict; crash windows; HTTP destination and ambiguity matrix; dependency cycle/depth/effect/egress denial; cursor ordering/history loss/resync; no task mutation on host failure.

### Slice 2E — hostile integrated gate and replacement evidence

Build signed Rust and TypeScript hostile/golden components from pinned authoring toolchains. Run protocol, import, resource, crash, effects, dependency, HTTP, event, cancellation and no-orphan matrices. Build optimized server/host separately; prove the server dependency tree contains no Wasmtime and disabled startup launches no host.

Slice 2E may add exactly one non-shipped optimized integration/measurement harness. It constructs the real Slice 2C supervisor with real storage/AppService and the real sibling host; its only path injection is the tests-only absolute Cargo binary path. It runs Rust and TypeScript profiles separately and measures multi-runtime scaling at one, four and sixteen loaded runtimes, including dependency graphs, one/four invocation admission and cleanup. It replaces the selected-path 45.0.3 active-runtime projections with clean 36.0.13 evidence while retaining separate default/Rust/TypeScript reports.

This harness is replacement runtime evidence only. It does not satisfy Wave 3 ordinary `ServerState` startup/restore/maintenance composition and cannot substitute for Wave 5 product-integrated default/Rust/TypeScript evidence. Obtain the complete Wave 2 security gate, retain the corrected cross-platform containment evidence, obtain a clean replacement full CI run at the current head, and close `P7-DEP-001` plus every other named material finding before Wave 2 acceptance.

## Ownership and lifecycle

- **SQLite/AppService:** exclusive durable package/grant/graph/desired-state/epoch/health/retry/backoff/dependent-propagation/invocation/receipt/event/effect/cursor authority and every typed lifecycle transition.
- **Parent supervisor:** exact sibling discovery, child process, host session, admission, cancellation, dependency ancestry, callback authorization, HTTPS transport, event workers and late-reply fencing; it only requests durable transitions.
- **Child host:** one Wasmtime Engine, at most 16 activation-fenced Component/Linker/Store/instance entries, independent admission and typed guest execution only; no durable or product authority.
- **Guest:** untrusted component memory and returned values only.

Start is profile reconciliation → selected verified desired graph → each admitted attempt increments its epoch once into `starting` → fresh host session → child spawn → exact v2/product-version Hello/reply → sequential dependency-order loads → required resync/catch-up → same-epoch active CAS → admission. Stop is close admission → cancel callbacks/calls → bounded drain → shutdown frame → kill fallback → wait/reap → clear session. Ordinary plugin-local failure retains the current attempt epoch and replaces one Store. Child/session-fatal failure advances each matching affected selected plugin exactly once in one atomic graph fence before replacement; a later retry advances once again and retains that retry epoch through activation. Any partial drain, CAS mismatch or ambiguous result stays fail-closed.

## Validation sequence

```text
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
cargo run --locked -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen -- --check
cargo audit
cargo deny check
cargo tree --locked -p junban-server -e normal
cargo tree --locked -p junban-plugin-host -e features
cargo build --locked --release -p junban-server -p junban-plugin-host
pnpm check
git diff --check
```

Focused host/component/hostile/benchmark commands are added with the owning slice and become authoritative only when committed in this plan and retained evidence.
