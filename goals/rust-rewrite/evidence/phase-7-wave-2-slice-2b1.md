# Phase 7 Wave 2 Slice 2B.1 — selective sandbox and serial guest execution

Date: 2026-08-05
Status: implemented — bounded first half of Slice 2B; Slice 2B.2 hostile containment remains
Parent: [`phase-7-wave-2-plan.md`](phase-7-wave-2-plan.md)
Open finding: `P7-DEP-001`

## Delivered boundary

- The isolated child still constructs exactly one Wasmtime Engine and accepts exactly one load attempt. A load now succeeds only after the child revalidates the component's public ABI, exact runtime-profile imports, canonical grant set and parent-inspected import/export fingerprint, compiles the retained bytes, constructs a selective linker, creates one limited Store and instantiates the component. `Loaded` is emitted only after all of those steps complete.
- Linker construction follows the inspected component rather than a broad world helper. Each actual capability-bearing `junban:plugin/host-*` import must have its corresponding canonical grant before compilation, and every actual host interface is added individually. Missing grant authority returns fenced `PermissionDenied` without instantiation or guest execution.
- TypeScript receives no WASI definitions. Rust receives only the exact frozen 0.2.6 interfaces `wasi:io/error`, `wasi:io/streams`, `wasi:cli/environment`, `wasi:cli/exit`, and `wasi:cli/stderr`. They are linked individually rather than with `wasmtime_wasi::p2::add_to_linker_*`: environment and arguments are empty, stdin streams are closed, stdout is absent, stderr is a bounded sink, and exit traps. No ambient WASI preopens/filesystem, network, random, clocks, inherited stdio/environment, processes, or HTTP are linked.
- One dedicated serial runtime thread exclusively owns the mutable Store and generated guest instance. The Store survives successful calls so guest state is retained. Idle unload drops the complete Store/instance before `Unloaded`; a trap or runtime failure also discards it before the fenced failure is reported.
- All nine public guest exports decode through the SDK's canonical typed invocation bodies, convert through the generated neutral→Wasmtime adapters, call the generated bindings, convert back through the fallible generated Wasmtime→neutral adapters, and construct kind-bound canonical outcomes. WIT `err(plugin-error)` remains `ChildFrame::Outcome`; a trap/runtime failure remains `ChildFrame::Failed`.
- Every Store uses `StoreLimits`, the frozen 10,000-element table ceiling, and the 2-MiB Wasm stack. Retained-component structural tests freeze the core-resource baselines that make Component Model execution possible: Rust has 13 core instances, one memory and two tables; TypeScript has eight core instances, one memory and two tables. Runtime limits now encode those profile-specific counts instead of the pre-execution placeholder value of one instance/table.
- Every invocation resets finite profile-specific fuel: 100,000,000 for Rust and 2,000,000,000 for TypeScript. Memory remains 64 MiB for Rust and 128 MiB for TypeScript. Epoch interruption is enabled and each Store establishes an epoch deadline, but Slice 2B.2 owns advancing wall deadlines, active interruption and recovery.
- Host imports register one exact pending callback, emit the SDK-canonical `CapabilityRequest` frame/body, and block only the runtime owner while the protocol reader remains live. The reader routes only an exact generation/epoch/session/invocation/callback/kind match. Stale, wrong-kind and duplicate replies receive bounded fenced failure frames without consuming the pending legal reply. Parent-supplied success, typed host error, and cancellation branches all round-trip through generated adapters.
- One-active-invocation admission rejects concurrent calls without touching the Store. Active cancel, unload and shutdown are explicitly fail-closed with `Unavailable`; they are not acknowledged before work has stopped. Idle unload and shutdown remain deterministic and reaped.

The SDK and `junban-server` remain Wasmtime-free. No server supervisor, AppService callback execution, HTTP transport, dependency service, event/effect commit, public route, registry or UI was added.

## Retained consumer evidence

The checked-in Rust 1.93/`wasm32-wasip2` consumer keeps its shared types import, exact four capability-bearing Junban host imports and five frozen WASI imports. Its lifecycle call performs legal settings, storage-list/get and log callbacks; its effect-mode command performs the task query, preserving the frozen invocation-mode authority. The process test proves canonical callback success, WIT host error and cancellation, keeps the valid callback pending across stale/wrong replies, rejects a duplicate after completion, rejects a busy invocation, fails active cancel/unload/shutdown closed, and unloads cleanly. A second load with the task grant removed fails before any callback or guest execution.

The checked-in TypeScript component remains a zero-WASI ComponentizeJS artifact with the same shared types import and exact four capability-bearing Junban host imports. It now retains an activation counter, exposes it from `call-service`, has one typed guest-error command and one trapping command, and still implements all nine exports. The launched-child test runs every export, calls activate twice to prove one retained instance, observes the count through the service export, distinguishes typed guest error from trap, and proves idle unload/shutdown cleanup.

Both consumer sources, generated bindings, committed artifacts, import sets, sizes and provenance hashes pass the retained consumer checker. The public WIT SHA-256 remains unchanged.

## Explicit Slice 2B.2 boundary

This checkpoint does **not** claim the hostile resource-exhaustion/cancellation/recovery matrix. Slice 2B.2 must still implement and prove advancing epoch wall deadlines, interruption of CPU loops, cancellation of blocked host futures, bounded host resource-table behavior, memory grow/bulk-memory/table/stack/output exhaustion, malformed/EOF/crash behavior during callbacks, failed-Store non-reuse, clean replacement instantiation, and the required cross-platform containment paths.

Compile/load wall-time enforcement and replacement optimized Rust/TypeScript runtime measurements also remain later evidence. Therefore this document does not close complete Slice 2B, Wave 2, the Wave 2 security gate, or `P7-DEP-001`.

## Validation

Passed from the Slice 2B.1 worktree:

```text
cargo fmt --all -- --check
cargo clippy --locked -p junban-plugin-sdk -p junban-plugin-host --all-targets --all-features -- -D warnings
cargo test --locked -p junban-plugin-sdk --all-targets --all-features
cargo test --locked -p junban-plugin-host --all-targets --all-features
cargo test --locked --workspace --all-features -- --test-threads=1
cargo run --locked -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen -- --check
python3 scripts/check-phase7-sdk-consumers.py
cargo audit
cargo deny check
cargo build --locked --release -p junban-server -p junban-plugin-host
pnpm check
node scripts/check-docs.mjs
cargo tree --locked -p junban-server -e normal
cargo tree --locked -p junban-plugin-sdk -e normal
cargo tree --locked -p junban-plugin-host -e features
git diff --check
```

Focused launched-child coverage also passed independently for the Rust callback/grant path and the zero-WASI TypeScript all-export/state/error/trap path. Dependency-tree inspection keeps Wasmtime confined to `junban-plugin-host`; no broad WASI linker helper is present.
