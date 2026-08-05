# Phase 7 Wave 2 Slice 2A — isolated child and exact protocol

Date: 2026-08-04
Status: implemented and focused validation passed; Slices 2B–2E remain
Parent: [`phase-7-wave-2-plan.md`](phase-7-wave-2-plan.md)

## Delivered boundary

- Added workspace binary `junban-plugin-host`. Exact `wasmtime` and `wasmtime-wasi` 36.0.13 dependencies exist only in this crate; both disable default features, and Wasmtime directly requests only `runtime`, `cranelift`, `component-model`, and `async`.
- Added a reusable strict stream codec over SDK-owned canonical frames. It checks the u32be header ceiling before allocation, rejects noncanonical/unknown/duplicate/type/protocol/version inputs, reads each exact capped raw body, and verifies its declared SHA-256 before dispatch.
- Minimally completed the SDK authority: hello exact-matches the existing `HOST_PROTOCOL_NAME` as protocol magic, and load carries the parent-inspected import/export fingerprint that the existing `Loaded` frame echoes. No second envelope or compatibility protocol was added.
- The launched child configures one on-demand, no-profiler Engine with Component Model, async host support, fuel consumption and epoch interruption enabled and component-model GC disabled. It compiles and retains at most one exact hash-bound component. It does not instantiate, link imports, create a Store, or execute a guest.
- Load, invoke, cancel, unload, callback, shutdown and EOF state are fenced by the exact process session and generation/epoch/plugin identities. Unsupported execution cases return the frozen fenced `Failed` shape. Compile failure is bounded `invalid_component`; malformed input exits with protocol-only stdout and a fixed redacted stderr message.
- Process tests launch the absolute sibling binary with its environment cleared, pipe only private protocol bytes, wait/reap it, and prove clean EOF/shutdown and stdout purity. The valid component fixture is assembled in test code from the Component Model binary header rather than committed as an opaque artifact.

No server route, supervisor, AppService bridge, database/schema change, linker, guest import, registry/UI, reference plugin, or Wave 3 composition is included.

## Dependency and runtime facts

`cargo metadata --locked --no-deps` reports Rust 1.93 and these direct host declarations:

```text
wasmtime: =36.0.13, default-features=false, features=runtime,cranelift,component-model,async
wasmtime-wasi: =36.0.13, default-features=false
```

The resolved host tree contains only Wasmtime 36.0.13. The normal `junban-server` tree contains no case-insensitive `wasmtime` match. There is no advisory ignore in `deny.toml`.

## Validation

Passed from the Slice 2A worktree:

```text
cargo fmt --all -- --check
cargo clippy --locked -p junban-plugin-sdk -p junban-plugin-host --all-targets --all-features -- -D warnings
cargo test --locked -p junban-plugin-sdk -p junban-plugin-host --all-targets --all-features
cargo tree --locked -p junban-plugin-host -e features
cargo tree --locked -p junban-plugin-host -e normal
cargo tree --locked -p junban-plugin-host -i wasmtime
cargo tree --locked -p junban-plugin-host -i wasmtime-wasi
cargo tree --locked -p junban-server -e normal
cargo audit
cargo deny check
rustc --version --verbose
cargo metadata --locked --no-deps --format-version 1
node scripts/check-docs.mjs
git diff --check
```

The focused tests cover canonical framing, protocol magic/version/type, unknown and duplicate fields, noncanonical JSON, truncation and header/body oversize, raw length/hash mismatch, compile failure, second/cross-identity load, pre-load and stale calls, exact failure correlation, protocol-only stdout, bounded redacted stderr, clean EOF/shutdown, and bounded hostile inputs without panic.

## Remaining Wave 2 work

Slice 2B must add the exact five-interface Rust WASI baseline and granted Junban interfaces selectively, Store/resource/fuel/epoch/wall/cancellation limits, instantiation, typed guest execution, trap recovery, and real call/cancel behavior. Slices 2C–2E still own the lazy parent supervisor, verified source bridge, AppService/capability/effect/dependency/HTTP/event callbacks, cross-platform hostile matrix, and replacement optimized Rust/TypeScript evidence.

`P7-DEP-001` remains open and the Wave 2 security gate is not claimed.
