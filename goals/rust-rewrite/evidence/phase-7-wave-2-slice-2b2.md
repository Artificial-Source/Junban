# Phase 7 Wave 2 Slice 2B.2 — hostile child containment and recovery

Date: 2026-08-05
Status: implemented — child boundary only; parent supervision and integrated review remain later slices
Parent: [`phase-7-wave-2-plan.md`](phase-7-wave-2-plan.md)
Open finding: `P7-DEP-001`

## Delivered boundary

- One condition-variable watchdog owns all active Wasmtime epoch advancement. Admission records the exact invocation deadline before queueing work. Commands, lifecycle calls, and host-rendered UI use 1,000 ms; event, render, validation, and resync calls use 250 ms. The watchdog advances the epoch while still holding the active-authority lock, preventing an old timeout/cancel from interrupting a replacement invocation. No correctness path polls or sleeps.
- Exact cancellation, unload, shutdown, protocol EOF, malformed input, and runtime-worker failure set one stop reason, cancel the one legal pending callback rendezvous, advance the epoch at most once, and wait for runtime ownership to drain. Cancel-vs-finish and control-vs-finish use one lock and one completion transition. Duplicate, stale, wrong-kind, and late callback replies remain fenced and cannot consume a legal pending reply.
- Successful invocations retain the Store and guest state. Trap, fuel exhaustion, wall timeout, limit failure, invalid/oversized output, cancellation, and abort enter a completing state, destroy the failed Store/instance outside the authority lock, and only then expose a terminal frame or allow a draining control acknowledgement. The next invocation lazily instantiates a clean Store from the retained Engine, selective Linker, and compiled Component.
- Callback registration and request publication are one fail-closed transition. A bounded nonblocking outbound reservation while holding callback authority prevents a request from appearing after timeout/cancel has won and prevents a full writer queue from wedging the watchdog.
- Stable public failures distinguish `timeout`, `cancelled`, `resource-limit`, `guest-error`, `permission-denied`, `stale-authority`, `invalid-frame`, and `unavailable`. Guest trap strings, guest stderr, canonical callback bodies, and secret-bearing data never enter child protocol failures or process diagnostics.
- Scope remains the selected child only. No server/AppService/supervisor, route, registry, HTTP capability execution, effect/event commit, UI, or reference package was added.

## Frozen runtime authority

| Authority                                     |                Rust |          TypeScript |
| --------------------------------------------- | ------------------: | ------------------: |
| Linear memory                                 |              64 MiB |             128 MiB |
| Core memories / tables                        |               1 / 2 |               1 / 2 |
| Core instances                                |                  14 |                   8 |
| Table elements                                |              10,000 |              10,000 |
| Fuel per invocation                           |         100,000,000 |       2,000,000,000 |
| Wasm stack                                    |               2 MiB |               2 MiB |
| Host resource table                           |                  64 |                  64 |
| Canonical host-call copy                      |               4 MiB |               4 MiB |
| Guest output / child frame                    |             256 KiB |             256 KiB |
| Guest log message / fields / invocation total | 4 KiB / 16 / 32 KiB | 4 KiB / 16 / 32 KiB |
| WASI stderr                                   |              32 KiB |          not linked |
| Command/lifecycle/UI wall deadline            |            1,000 ms |            1,000 ms |
| Event/render/validation/resync wall deadline  |              250 ms |              250 ms |

The retained Rust hostile fixture's deliberate second raw core import of the already-authorized `wasi:cli/stderr@0.2.6` instance raises its structurally frozen core-instance baseline from Slice 2B.1's 13 to 14 and its largest initial table from 44 to 60. Its actual component import set remains the exact accepted five WASI interfaces plus the same Junban interfaces. The runtime limit was raised only to this re-inspected exact fixture baseline; the two-table and 10,000-element ceilings remain unchanged.

## Hostile retained consumers

The hash-retained Rust component now exposes deterministic commands for:

- epoch-interrupted CPU spin and distinct finite-fuel exhaustion;
- linear-memory growth denial and bounded bulk-memory work;
- recursive stack exhaustion;
- oversized effect output;
- guest-log message, field-count, and aggregate-byte exhaustion;
- 65 simultaneously retained raw stderr resource handles against the 64-entry host table;
- bounded WASI stderr overflow;
- typed guest error and guest trap markers used to prove diagnostic redaction.

The retained TypeScript component now exposes deterministic CPU spin and oversized host-rendered output. A test-local copy changes its initial core table minimum from 7,692 to 10,001 without changing its inspected imports or exports, proving initial core-table exhaustion before guest execution. Both profiles are loaded from one retained byte authority and cleanly re-instantiated after failed execution.

Launched-child tests cover successful state retention; failure-state reset; timeout of CPU and blocked callbacks; fuel, memory, bulk-memory, core-table, host-resource, stack, output, log, and stderr limits; active cancel/unload/shutdown; cancel-vs-finish races; exact stale/late callback handling; malformed callback frames; EOF and forced child death during callbacks; forbidden filesystem, network, random, clock, and WASI HTTP imports; process reap; and absence of guest markers from protocol/process diagnostics. The repository CI adds a Linux/macOS/Windows matrix for the Rust launched-child containment suite plus the retained TypeScript all-export/failure/replacement path. Local evidence below is Linux; CI owns the other two required executions and must pass before integration acceptance.

## Exact compile/load ownership

`RuntimeLimits.compile_timeout_ms` remains exactly **10,000 ms** in the canonical SDK protocol. The child does **not** pretend to enforce it. Wasmtime 36 component compilation and initial instantiation are synchronous and cannot be safely interrupted by the invocation watchdog inside the same child. Slice 2C's parent supervisor owns the exact deadline: on expiry it must kill and reap the child, fence the complete generation/epoch/session authority, and reject every late frame. The child-local watchdog starts only after a component is loaded and an invocation is admitted.

This is deliberate later ownership, not a deferral or weakening of the 10-second authority.

## Focused implementation review

The containment review found and closed three ordering defects before this checkpoint:

1. A failed Store was initially terminalized before destruction. Completion now enters a private completing state, drops outside the lock, and terminalizes only after destruction; launched replacement/control tests cover the resulting order.
2. Epoch advancement initially occurred after releasing active authority, allowing a theoretical old-timeout increment to hit a just-admitted replacement. Advancement now occurs under the authority lock; timeout-then-immediate-success replacement tests cover both deadline classes.
3. Callback registration and outbound publication initially had a stop race. They are now one bounded nonblocking authority transition, so no callback request can be published after stop wins.

No remaining high-confidence child-boundary security finding was identified. Independent integrated security review remains Slice 2E and is not claimed here.

## Validation

Passed from the Slice 2B.2 worktree:

```text
cargo fmt --all -- --check
cargo clippy --locked -p junban-plugin-sdk -p junban-plugin-host --all-targets --all-features -- -D warnings
cargo test --locked -p junban-plugin-sdk --all-targets --all-features
cargo test --locked -p junban-plugin-host --all-targets --all-features -- --test-threads=1
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

Focused launched-child tests passed for Rust wall/callback cancellation and the full hostile/resource/control/EOF matrix, plus TypeScript all-export/state/trap/fuel/wall/output replacement and initial core-table rejection. Dependency-tree inspection confirmed that normal `junban-server` and `junban-plugin-sdk` contain no Wasmtime, only `junban-plugin-host` carries the selected Wasmtime features, and no broad WASI linker helper exists. `cargo deny` retained only its policy-allowed duplicate-version warnings; `pnpm check` retained existing non-fatal frontend lint/build-size warnings. The configured macOS/Windows CI matrix was not executed locally and is not falsely claimed as observed evidence.

Optimized integrated replacement memory/cold/warm performance measurements remain the explicitly frozen Slice 2E owner; this child checkpoint does not relabel debug test timings or the historical Wave 0 projection as product evidence.
