# Phase 7 Wave 2 Slice 2B.2 — hostile child containment and recovery

Date: 2026-08-05
Status: implemented — child boundary only; parent supervision and integrated review remain later slices
Parent: [`phase-7-wave-2-plan.md`](phase-7-wave-2-plan.md)
Open findings: `P7-DEP-001`, `P7-PLAN-RUNTIME-001`, `P7-RUNTIME-SEC-001`

## Delivered boundary

- One condition-variable watchdog owns all active Wasmtime epoch advancement. Admission records the exact invocation deadline before queueing work. Commands, lifecycle calls, and host-rendered UI use 1,000 ms; event, render, validation, and resync calls use 250 ms. The watchdog advances the epoch while still holding the active-authority lock, preventing an old timeout/cancel from interrupting a replacement invocation. No correctness path polls or sleeps.
- Exact cancellation, unload, shutdown, protocol EOF, malformed input, and runtime-worker failure set one stop reason, cancel the one legal pending callback rendezvous, advance the epoch at most once, and wait for runtime ownership to drain. Cancel-vs-finish and control-vs-finish use one lock and one completion transition. Duplicate, stale, wrong-kind, and late callback replies remain fenced and cannot consume a legal pending reply.
- Successful invocations retain the Store and guest state. Trap, fuel exhaustion, wall timeout, limit failure, invalid/oversized output, cancellation, and abort enter a completing state, destroy the failed Store/instance outside the authority lock, and only then expose a terminal frame or allow a draining control acknowledgement. The next invocation lazily instantiates a clean Store from the retained Engine, selective Linker, and compiled Component.
- Callback registration and request publication are one fail-closed transition. A bounded nonblocking outbound reservation while holding callback authority prevents a request from appearing after timeout/cancel has won and prevents a full writer queue from wedging the watchdog.
- Stable public failures distinguish `timeout`, `cancelled`, `resource-limit`, `guest-error`, `permission-denied`, `stale-authority`, `invalid-frame`, and `unavailable`. Guest trap strings, guest stderr, canonical callback bodies, Wasmtime hostcall-fuel diagnostics, and secret-bearing data never enter child protocol failures or process diagnostics.
- Follow-up correction: exact cross-platform calibration rejected the macOS `RLIMIT_AS` remedy. Every initial and replacement Store now receives 4,464,640 bytes through Wasmtime 36.0.13 `Store::set_hostcall_fuel`, asserts the readback, and does so before Component instantiation. This guest-to-host lift authority is separate from per-invocation wasm execution fuel and does not meter host-to-guest values.
- Scope remains the selected child only. No server/AppService/supervisor, route, registry, HTTP capability execution, effect/event commit, UI, or reference package was added.

## Frozen runtime authority

| Authority                                     |                Rust |          TypeScript |
| --------------------------------------------- | ------------------: | ------------------: |
| Linear memory                                 |              64 MiB |             128 MiB |
| Core memories / tables                        |               1 / 2 |               1 / 2 |
| Core instances                                |                  14 |                   8 |
| Table elements                                |              10,000 |              10,000 |
| Wasm execution fuel per invocation            |         100,000,000 |       2,000,000,000 |
| Guest-to-host hostcall fuel per call          |     4,464,640 bytes |     4,464,640 bytes |
| Wasm stack                                    |               2 MiB |               2 MiB |
| Host resource table                           |                  64 |                  64 |
| Canonical host-call copy                      |               4 MiB |               4 MiB |
| Guest output / child frame                    |             256 KiB |             256 KiB |
| Guest log message / fields / invocation total | 4 KiB / 16 / 32 KiB | 4 KiB / 16 / 32 KiB |
| WASI stderr                                   |              32 KiB |          not linked |
| Command/lifecycle/UI wall deadline            |            1,000 ms |            1,000 ms |
| Event/render/validation/resync wall deadline  |              250 ms |              250 ms |

The retained Rust hostile fixture's deliberate second raw core import of the already-authorized `wasi:cli/stderr@0.2.6` instance raises its structurally frozen core-instance baseline from Slice 2B.1's 13 to 14 and its largest initial table from 44 to 60. Its actual component import set remains the exact accepted five WASI interfaces plus the same Junban interfaces. The runtime limit was raised only to this re-inspected exact fixture baseline; the two-table and 10,000-element ceilings remain unchanged.

The hostcall constant is not copied from Wasmtime's 128-MiB default. Its exact derivation is **4,194,304 callback-body bytes + 139,264 canonical structural bytes + 131,072 margin = 4,464,640 bytes**. The structural term is the largest SDK-valid nested request: `256 × (named-value SIZE32 32 + 64 × list-element SIZE32 8)`. Generated `ComponentType` assertions freeze those sizes and the 20-byte `kv-operation` used by the hostile result; a table covers every one of the 11 import functions and 9 export functions and conservatively bounds output lifting at four times the 256-KiB canonical outcome body (the worst eight-byte flat integer-list element versus two compact JSON bytes), still below the import maximum. The WIT, 4-MiB callback cap, 256-KiB request/outcome caps, guest-memory limits, wall deadlines, reservation tuning, and wasm fuel remain unchanged.

## Hostile retained consumers

The hash-retained Rust component now exposes deterministic commands for:

- epoch-interrupted CPU spin and distinct finite-fuel exhaustion;
- linear-memory growth denial and bounded bulk-memory work;
- recursive stack exhaustion;
- oversized effect output;
- guest-log message, field-count, and aggregate-byte exhaustion;
- 65 simultaneously retained raw stderr resource handles against the 64-entry host table;
- bounded WASI stderr overflow;
- typed guest error and guest trap markers used to prove diagnostic redaction;
- an 8-KiB maximum-valid task search and a 4,190,208-byte near-callback-bound canonical task search that both reach the generated import adapter/callback and return normally;
- a 558,081-element empty task-tag-ID list whose 4,464,648 canonical flat bytes exhaust hostcall fuel before callback publication; its compact private body would remain below 4 MiB if the Store configuration were omitted, making the regression omission-sensitive.

The retained TypeScript component now exposes deterministic CPU spin, oversized host-rendered output, and an oversized-result-string `kv-patch` result. Its 4,464,641-byte delete key exhausts hostcall fuel during guest-to-host post-return before the generated adapter or protocol encoder can retain the string. A test-local copy changes its initial core table minimum from 7,692 to 10,001 without changing its inspected imports or exports, proving initial core-table exhaustion before guest execution. Both profiles are loaded from one retained byte authority and cleanly re-instantiated after failed execution.

Launched-child tests cover successful state retention; failure-state reset; timeout of CPU and blocked callbacks; fuel, memory, bulk-memory, core-table, host-resource, stack, output, log, and stderr limits; active cancel/unload/shutdown; cancel-vs-finish races; exact stale/late callback handling; malformed callback frames; EOF and forced child death during callbacks; forbidden filesystem, network, random, clock, and WASI HTTP imports; process reap; and absence of guest markers from protocol/process diagnostics. The repository CI adds a Linux/macOS/Windows matrix for the Rust launched-child containment suite plus the retained TypeScript all-export/failure/replacement path. Local evidence below is Linux; CI owns the other two required executions and must pass before integration acceptance.

## Exact compile/load ownership

`RuntimeLimits.compile_timeout_ms` remains exactly **10,000 ms** in the canonical SDK protocol. The child does **not** pretend to enforce it. Wasmtime 36 component compilation and initial instantiation are synchronous and cannot be safely interrupted by the invocation watchdog inside the same child. Slice 2C's parent supervisor owns the exact deadline: on expiry it must kill and reap the child, fence the complete generation/epoch/session authority, and reject every late frame. The child-local watchdog starts only after a component is loaded and an invocation is admitted.

This is deliberate later ownership, not a deferral or weakening of the 10-second authority.

## Focused implementation review

The containment review found and closed three ordering defects before this checkpoint:

1. A failed Store was initially terminalized before destruction. Completion now enters a private completing state, drops outside the lock, and terminalizes only after destruction; launched replacement/control tests cover the resulting order.
2. Epoch advancement initially occurred after releasing active authority, allowing a theoretical old-timeout increment to hit a just-admitted replacement. Advancement now occurs under the authority lock; timeout-then-immediate-success replacement tests cover both deadline classes.
3. Callback registration and outbound publication initially had a stop race. They are now one bounded nonblocking authority transition, so no callback request can be published after stop wins.

The later `P7-RUNTIME-SEC-001` review identified the native canonical-lift amplification gap after this original checkpoint. The approved hostcall-fuel correction above is implemented, but no finding is silently closed: independent focused recheck remains required, the three Wave 2 findings remain open, and Slice 2C is not authorized.

## Validation

Passed from the Slice 2B.2 worktree:

```text
cargo fmt --all -- --check
cargo clippy --locked -p junban-plugin-sdk -p junban-plugin-host --all-targets --all-features -- -D warnings
cargo test --locked -p junban-plugin-sdk --all-targets --all-features
cargo test --locked -p junban-plugin-host --all-targets --all-features -- --test-threads=1
cargo test --locked --release -p junban-plugin-host --test containment maximum_valid_import_reaches_callback_and_returns_normally -- --exact
cargo test --locked --release -p junban-plugin-host --test containment oversized_import_is_rejected_before_callback_and_replaces_rust_store -- --exact
cargo test --locked --release -p junban-plugin-host --test process_host retained_typescript_invokes_all_exports_and_contains_oversized_result_string -- --exact
cargo test --locked --workspace --all-features -- --test-threads=1
cargo run --locked -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen -- --check
python3 scripts/check-phase7-sdk-consumers.py
cargo audit
cargo deny check
cargo build --locked --release -p junban-server -p junban-plugin-host
pnpm check
node scripts/check-docs.mjs
git diff --check
```

Focused launched-child tests passed for Rust wall/callback cancellation and the full hostile/resource/control/EOF matrix, plus TypeScript all-export/state/trap/fuel/wall/output replacement and initial core-table rejection. The hostcall follow-up adds omission-sensitive Store readback/default checks, all-generated-interface linker coverage, exact 11-import/9-export transfer-bound enumeration, maximum-valid adapter/callback success, oversized-import pre-callback failure, oversized-result-string post-return failure, normalized `resource-limit`, failed-Store destruction, same-process replacement, and empty diagnostics. Dependency-tree inspection confirmed that normal `junban-server` and `junban-plugin-sdk` contain no Wasmtime, only `junban-plugin-host` carries the selected Wasmtime features, and no broad WASI linker helper exists. `cargo deny` retained only its policy-allowed duplicate-version warnings; `pnpm check` retained existing non-fatal frontend lint/build-size warnings. The configured macOS/Windows CI matrix was not executed locally and is not falsely claimed as observed evidence.

The raw optimized Linux exact-child evidence is [`phase-7-hostcall-transfer-linux.json`](phase-7-hostcall-transfer-linux.json). Its prior campaign is superseded; the retained report now records the oversized-result-string fixture's exact executable and artifact hashes, five-run durations, and GNU time maximum-resident-set measurements. The TypeScript measurement includes ordinary compilation/instantiation and is not mislabeled as transfer-only allocation. Integrated product cold/warm and cross-platform replacement measurements remain the explicitly frozen Slice 2E owner.
